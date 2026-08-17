import { Buffer } from "buffer";
import {
  requireOptionalNativeModule,
  type EventSubscription,
} from "expo-modules-core";
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

interface NativeMtlsIdentityMetadata {
  identityId: string;
  displayName?: string;
  subjectSummary?: string;
  expiresAt?: string;
  importedAt: string;
}

interface PaseoMtlsWebSocketModule {
  importPkcs12(base64: string, password: string, fileName?: string): Promise<NativeMtlsIdentityMetadata>;
  deleteIdentity(identityId: string): Promise<void>;
  getIdentityMetadata(identityId: string): Promise<NativeMtlsIdentityMetadata | null>;
  connect(
    socketId: string,
    url: string,
    identityId: string,
    headers?: Record<string, string>,
    protocols?: string[],
  ): Promise<void>;
  sendString(socketId: string, data: string): Promise<void>;
  sendBinary(socketId: string, base64: string): Promise<void>;
  close(socketId: string, code?: number, reason?: string): Promise<void>;
  addListener(eventName: "onSocketOpen", handler: (event: MtlsSocketOpenEvent) => void): EventSubscription;
  addListener(
    eventName: "onSocketMessage",
    handler: (event: MtlsSocketMessageEvent) => void,
  ): EventSubscription;
  addListener(eventName: "onSocketClose", handler: (event: MtlsSocketCloseEvent) => void): EventSubscription;
  addListener(eventName: "onSocketError", handler: (event: MtlsSocketErrorEvent) => void): EventSubscription;
}

const module = requireOptionalNativeModule<PaseoMtlsWebSocketModule>("PaseoMtlsWebSocket");

function requireModule(): PaseoMtlsWebSocketModule {
  if (!module) {
    throw new Error("Paseo mTLS WebSocket module is not available in this build");
  }
  return module;
}

export function isMtlsWebSocketAvailable(): boolean {
  return module !== null;
}

export async function importMtlsPkcs12Identity(input: MtlsPkcs12ImportInput): Promise<MtlsIdentityMetadata> {
  const payload = await requireModule().importPkcs12(
    Buffer.from(input.bytes).toString("base64"),
    input.password,
    input.fileName,
  );
  return payload;
}

export async function deleteMtlsIdentity(identityId: string): Promise<void> {
  await requireModule().deleteIdentity(identityId);
}

export async function getMtlsIdentityMetadata(identityId: string): Promise<MtlsIdentityMetadata | null> {
  return await requireModule().getIdentityMetadata(identityId);
}

export async function connectMtlsSocket(input: MtlsSocketConnectOptions): Promise<void> {
  await requireModule().connect(
    input.socketId,
    input.url,
    input.identityId,
    input.headers,
    input.protocols,
  );
}

export async function sendMtlsSocketString(socketId: string, data: string): Promise<void> {
  await requireModule().sendString(socketId, data);
}

export async function sendMtlsSocketBinary(socketId: string, base64: string): Promise<void> {
  await requireModule().sendBinary(socketId, base64);
}

export async function closeMtlsSocket(socketId: string, code?: number, reason?: string): Promise<void> {
  await requireModule().close(socketId, code, reason);
}

export function addMtlsSocketOpenListener(handler: (event: MtlsSocketOpenEvent) => void): EventSubscription {
  return requireModule().addListener("onSocketOpen", handler);
}

export function addMtlsSocketMessageListener(
  handler: (event: MtlsSocketMessageEvent) => void,
): EventSubscription {
  return requireModule().addListener("onSocketMessage", handler);
}

export function addMtlsSocketCloseListener(
  handler: (event: MtlsSocketCloseEvent) => void,
): EventSubscription {
  return requireModule().addListener("onSocketClose", handler);
}

export function addMtlsSocketErrorListener(
  handler: (event: MtlsSocketErrorEvent) => void,
): EventSubscription {
  return requireModule().addListener("onSocketError", handler);
}
