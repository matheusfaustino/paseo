# iOS mTLS Proposal

## Goal

Add iOS-only mutual TLS support for direct host connections so the app can connect to a daemon behind Cloudflare Access or a similar mTLS-protected edge.

This proposal is intentionally narrow:

- iOS only
- `directTcp` only
- TLS required
- one imported PKCS#12 identity per direct connection
- no relay support
- no Android, web, or desktop support
- no custom CA or self-signed server-trust handling in v1

## Why This Scope

The current app uses the shared WebSocket client path for direct TCP hosts. That path can toggle TLS and attach headers, but it does not expose a clean way to present a client certificate during the TLS handshake.

For the target homelab case, the simplest working shape is:

1. import a `.p12` / `.pfx` file on iOS
2. store the identity in Keychain
3. use an iOS-native WebSocket transport for mTLS connections
4. leave the existing JS daemon client unchanged above the transport layer

Cloudflare-hosted access lowers scope because server trust should succeed through the normal Apple trust store.

## Current Integration Points

Relevant files:

- `packages/protocol/src/host-connection-schema.ts`
- `packages/app/src/types/host-connection.ts`
- `packages/app/src/runtime/host-runtime.ts`
- `packages/app/src/runtime/websocket-factory.ts`
- `packages/app/src/utils/test-daemon-connection.ts`
- `packages/app/src/components/add-host-modal.tsx`
- `packages/app/src/hooks/use-file-picker.ts`

Important current behavior:

- `directTcp` connections store `endpoint`, `useTls`, and optional `password`
- the app always uses the generic React Native WebSocket path for direct TCP connections
- direct-host probing happens before persistence through `probeAndUpsertDirectConnection`

## Proposed V1 Architecture

### Summary

Add a native iOS module that:

- imports PKCS#12 files into Keychain
- returns a stable native `identityId`
- opens a native WebSocket connection using that identity
- forwards socket events back to JS

Then branch the transport selection in the app:

- plain `directTcp` keeps using the existing transport
- `directTcp` with `mtls.identityId` uses the new iOS native transport

### Transport Choice

Do not patch global React Native `WebSocket`.

Instead, use a dedicated transport factory for the mTLS path. This keeps the behavior local to Paseo and avoids depending on undocumented React Native WebSocket internals.

### Native Networking Shape

Use Apple networking primitives that support authentication challenge handling for client certificates. The implementation detail can be finalized during build, but the expected shape is:

- native socket object keyed by a JS-visible `connectionId`
- challenge handler resolves a `SecIdentity` from Keychain
- native layer answers the client-certificate challenge with `URLCredential(identity:certificates:persistence:)`

## Data Model

Extend `directTcp` with optional mTLS metadata.

Proposed shape:

```ts
interface DirectTcpMtlsConfig {
  identityId: string;
  displayName?: string;
  subjectSummary?: string;
  expiresAt?: string;
  importedAt: string;
}
```

```ts
type DirectTcpHostConnection = {
  id: string;
  type: "directTcp";
  endpoint: string;
  useTls?: boolean;
  password?: string;
  mtls?: DirectTcpMtlsConfig;
};
```

Rules:

- `mtls` is allowed only when `useTls === true`
- JS persistence stores only metadata and `identityId`
- raw certificate bytes are never stored in host profiles
- PKCS#12 passwords are never stored after import

## Native Module

Create a new Expo module:

- `packages/app/modules/paseo-mtls-websocket/`

Suggested native API:

### Identity APIs

`importPkcs12`

- input: `{ base64, password, fileName? }`
- output: `{ identityId, displayName?, subjectSummary?, expiresAt? }`

Behavior:

- decodes the PKCS#12 payload
- imports the identity
- stores the identity in Keychain
- returns a stable identifier for later socket use

`deleteIdentity`

- input: `{ identityId }`
- output: `void`

`getIdentityMetadata`

- input: `{ identityId }`
- output: `{ identityId, displayName?, subjectSummary?, expiresAt? } | null`

### Socket APIs

`connect`

- input: `{ socketId, url, headers?, protocols?, identityId }`

`sendString`

- input: `{ socketId, data }`

`sendBinary`

- input: `{ socketId, base64 }`

`close`

- input: `{ socketId, code?, reason? }`

### Events

- `open`
- `message`
- `close`
- `error`

Each event payload should include `socketId`.

## JS Transport Layer

Add an iOS-only transport adapter under app runtime code.

Suggested files:

- `packages/app/src/runtime/ios-mtls-websocket-transport.ios.ts`
- `packages/app/src/runtime/ios-mtls-websocket-transport.ts`

Responsibilities:

- implement the existing `DaemonTransportFactory` contract
- map JS sends and closes to the native module
- translate native events into transport callbacks
- normalize close and error behavior to match the existing daemon client expectations

This should use `transportFactory` instead of `webSocketFactory` for the mTLS path.

## Host Runtime Integration

Update direct-host config and probing in:

- `packages/app/src/runtime/host-runtime.ts`
- `packages/app/src/utils/test-daemon-connection.ts`

Decision rule:

- if connection type is not `directTcp`, do nothing
- if `directTcp` has no `mtls`, do nothing
- if `directTcp` has `mtls.identityId`, use the iOS native mTLS transport

`probeAndUpsertDirectConnection` should accept new optional mTLS input so that validation happens before persistence.

Suggested addition:

```ts
probeAndUpsertDirectConnection(input: {
  endpoint: string;
  useTls?: boolean;
  password?: string;
  label?: string;
  mtls?: DirectTcpMtlsConfig;
})
```

## Add Host Flow

Extend the direct add-host UI in `packages/app/src/components/add-host-modal.tsx`.

### V1 UX

When TLS is enabled, show:

- `Use client certificate` toggle
- `Import .p12` action
- certificate password input during import
- imported certificate summary
- `Replace certificate`
- `Remove certificate`

Constraints:

- only allow one imported certificate per connection
- only allow `.p12` / `.pfx`
- hide or disable mTLS controls when TLS is off
- if TLS is turned off, clear the pending imported identity from the unsaved form state

### File Import

Reuse the existing file picker and restrict selection at the UI level to PKCS#12 files.

The import flow should be:

1. pick file
2. prompt for PKCS#12 password
3. call native import
4. store returned metadata in local form state
5. use that metadata when probing and saving

## Persistence Behavior

Persist the `mtls` metadata in the host registry with the direct connection.

Replacing a certificate should:

- keep the same direct connection identity from the app perspective
- update the `mtls` metadata
- optionally delete the old native identity after the new one imports successfully

Removing a host connection should delete the associated native identity if no other stored connection references it.

## Error Model

The app should distinguish these cases:

- invalid PKCS#12 file
- incorrect PKCS#12 password
- imported identity missing from Keychain
- TLS handshake failed
- server requested or rejected client certificate
- hostname or DNS error
- normal daemon password failure after TLS succeeds

Add host copy should keep the current friendly grouping, but retain raw technical details in diagnostics.

## Testing

### Unit Tests

- schema parsing for `directTcp.mtls`
- stored host normalization with and without `mtls`
- transport selection logic in host runtime
- add-host form behavior around TLS and certificate state

### Native Tests

- PKCS#12 import success
- PKCS#12 wrong password
- Keychain lookup by `identityId`
- identity deletion

### Manual QA

Target environment:

- iOS simulator or device
- daemon exposed behind Cloudflare with client-cert auth required

Scenarios:

- connect with valid client certificate
- connect with no client certificate
- connect with replaced certificate
- reconnect after background and foreground
- remove host and re-add
- expired or invalid certificate

## Rollout Order

1. extend host schema and stored connection types
2. build native PKCS#12 import and Keychain storage
3. build native mTLS WebSocket transport
4. branch host runtime to use the new transport
5. extend direct add-host UI
6. add error handling and diagnostics
7. run targeted QA against Cloudflare-protected daemon access

## Out Of Scope

- relay mTLS
- Android implementation
- custom CA installation guidance
- self-signed or private-root server trust flows
- PEM cert and key import
- shared certificate management UI outside host settings
- automatic rotation or renewal

## Open Questions

1. Should the v1 UI allow editing mTLS on existing direct hosts, or only during add-host plus replace/remove from host settings?
2. Should removing a connection immediately delete its native identity, or should deletion be reference-counted across connections?
3. Do we want a lightweight diagnostics panel line that indicates `mTLS configured` for a connection?
4. Do we need a minimum iOS version constraint for the chosen native WebSocket implementation?

## Recommendation

Build the narrow iOS-only `directTcp` version first.

This covers the Cloudflare homelab use case with the smallest surface area, keeps transport risk isolated, and avoids turning a targeted networking feature into a broader cross-platform abstraction project.
