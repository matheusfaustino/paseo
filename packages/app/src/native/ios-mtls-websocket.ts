import type { EventSubscription } from "expo-modules-core";
import type { DirectTcpMtlsConfig } from "@getpaseo/protocol/host-connection-schema";

export interface MtlsIdentityMetadata extends DirectTcpMtlsConfig {}

export interface MtlsSocketConnectOptions {
  socketId: string;
  url: string;
  identityId: string;
  headers?: Record<string, string>;
  protocols?: string[];
}

export interface MtlsSocketOpenEvent {
  socketId: string;
  negotiatedProtocol: string | null;
}

export interface MtlsSocketMessageEvent {
  socketId: string;
  type: "string" | "binary";
  text?: string;
  base64?: string;
}

export interface MtlsSocketCloseEvent {
  socketId: string;
  code: number;
  reason: string;
}

export interface MtlsSocketErrorEvent {
  socketId: string;
  message: string;
}

export interface MtlsPkcs12ImportInput {
  bytes: Uint8Array;
  password: string;
  fileName?: string;
}

function createNoopSubscription(): EventSubscription {
  return {
    remove() {},
  } as EventSubscription;
}

export function isMtlsWebSocketAvailable(): boolean {
  return false;
}

export async function importMtlsPkcs12Identity(
  _input: MtlsPkcs12ImportInput,
): Promise<MtlsIdentityMetadata> {
  throw new Error("Client certificate import is only available on iOS native builds");
}

export async function deleteMtlsIdentity(_identityId: string): Promise<void> {
  throw new Error("Client certificate management is only available on iOS native builds");
}

export async function getMtlsIdentityMetadata(
  _identityId: string,
): Promise<MtlsIdentityMetadata | null> {
  return null;
}

export async function connectMtlsSocket(_input: MtlsSocketConnectOptions): Promise<void> {
  throw new Error("mTLS direct connections are only available on iOS native builds");
}

export async function sendMtlsSocketString(_socketId: string, _data: string): Promise<void> {
  throw new Error("mTLS direct connections are only available on iOS native builds");
}

export async function sendMtlsSocketBinary(_socketId: string, _base64: string): Promise<void> {
  throw new Error("mTLS direct connections are only available on iOS native builds");
}

export async function closeMtlsSocket(
  _socketId: string,
  _code?: number,
  _reason?: string,
): Promise<void> {
  throw new Error("mTLS direct connections are only available on iOS native builds");
}

export function addMtlsSocketOpenListener(
  _handler: (event: MtlsSocketOpenEvent) => void,
): EventSubscription {
  return createNoopSubscription();
}

export function addMtlsSocketMessageListener(
  _handler: (event: MtlsSocketMessageEvent) => void,
): EventSubscription {
  return createNoopSubscription();
}

export function addMtlsSocketCloseListener(
  _handler: (event: MtlsSocketCloseEvent) => void,
): EventSubscription {
  return createNoopSubscription();
}

export function addMtlsSocketErrorListener(
  _handler: (event: MtlsSocketErrorEvent) => void,
): EventSubscription {
  return createNoopSubscription();
}
