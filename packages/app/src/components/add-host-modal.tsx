import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Alert, Platform, Pressable, Text, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Check, ChevronDown, ChevronRight, Eye, EyeOff, Link2 } from "lucide-react-native";
import type { DirectTcpHostConnection, HostProfile } from "@/types/host-connection";
import { useHosts, useHostMutations } from "@/runtime/host-runtime";
import {
  parseConnectionUri,
  serializeConnectionUri,
  serializeConnectionUriForStorage,
} from "@/utils/daemon-endpoints";
import { DaemonConnectionTestError } from "@/utils/test-daemon-connection";
import { AdaptiveModalSheet, AdaptiveTextInput, type SheetHeader } from "./adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useFilePicker } from "@/hooks/use-file-picker";
import { getFileExtension } from "@/attachments/file-types";
import {
  deleteMtlsIdentity,
  importMtlsPkcs12Identity,
  isMtlsWebSocketAvailable,
  type MtlsIdentityMetadata,
} from "@/native/ios-mtls-websocket";

const FLEX_ONE_STYLE = { flex: 1 } as const;

interface DirectConnectionDraft {
  host: string;
  port: string;
  useTls: boolean;
  password: string;
  mtls?: DirectTcpHostConnection["mtls"];
}

interface PreparedDirectConnection {
  uri: string;
  endpoint: string;
  useTls: boolean;
  password?: string;
  mtls?: DirectTcpHostConnection["mtls"];
}

interface DirectConnectionLabels {
  hostRequired: string;
  invalidPort: string;
  invalidConnection: string;
  failedToConnect: (endpoint: string) => string;
  noAdditionalDetails: (detail: string) => string;
  timedOut: string;
  refused: string;
  hostNotFound: string;
  hostUnreachable: string;
  tlsError: string;
  unableToConnect: string;
}

const styles = StyleSheet.create((theme) => ({
  field: {
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  portRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  hostField: {
    flex: 1,
    minWidth: 0,
  },
  portField: {
    width: 112,
  },
  passwordRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  passwordInput: {
    flex: 1,
    minWidth: 0,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  checkboxChecked: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  advancedToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    alignSelf: "flex-start",
    paddingVertical: theme.spacing[1],
  },
  advancedText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  certificateActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  certificateCard: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  certificateTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  certificateDetail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
  helper: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));

function isIpv6Host(host: string): boolean {
  return host.includes(":") && !host.startsWith("[") && !host.endsWith("]");
}

function buildConnectionUriFromDraft(
  draft: DirectConnectionDraft,
  labels: DirectConnectionLabels,
): string {
  const host = draft.host.trim();
  const port = Number(draft.port.trim());
  if (!host) {
    throw new Error(labels.hostRequired);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(labels.invalidPort);
  }

  return serializeConnectionUriForStorage({
    host,
    port,
    isIpv6: isIpv6Host(host),
    useTls: draft.useTls,
    ...(draft.password ? { password: draft.password } : {}),
  });
}

function prepareDirectConnection(
  draft: DirectConnectionDraft,
  labels: DirectConnectionLabels,
): PreparedDirectConnection {
  const parsed = parseConnectionUri(buildConnectionUriFromDraft(draft, labels));
  const endpoint = parsed.isIpv6
    ? `[${parsed.host}]:${parsed.port}`
    : `${parsed.host}:${parsed.port}`;

  return {
    uri: serializeConnectionUri(parsed),
    endpoint,
    useTls: parsed.useTls,
    ...(parsed.password ? { password: parsed.password } : {}),
    ...(draft.mtls ? { mtls: draft.mtls } : {}),
  };
}

function isPkcs12FileName(fileName: string): boolean {
  const extension = getFileExtension(fileName);
  return extension === ".p12" || extension === ".pfx";
}

function draftFromConnectionUri(uri: string): DirectConnectionDraft {
  const parsed = parseConnectionUri(uri);
  return {
    host: parsed.host,
    port: String(parsed.port),
    useTls: parsed.useTls,
    password: parsed.password ?? "",
  };
}

function normalizeTransportMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  const trimmed = message.trim();
  if (!trimmed) return null;
  return trimmed;
}

function formatTechnicalTransportDetails(
  details: (string | null)[],
  labels: DirectConnectionLabels,
): string | null {
  const unique = Array.from(
    new Set(
      details
        .map((value) => normalizeTransportMessage(value))
        .filter((value): value is string => Boolean(value))
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );

  if (unique.length === 0) return null;

  const allGeneric = unique.every((value) => {
    const lower = value.toLowerCase();
    return lower === "transport error" || lower === "transport closed";
  });

  if (allGeneric) {
    return labels.noAdditionalDetails(unique[0] ?? "");
  }

  return unique.join(" — ");
}

function buildConnectionFailureCopy(input: {
  endpoint: string;
  error: unknown;
  labels: DirectConnectionLabels;
}): { title: string; detail: string | null; raw: string | null } {
  const { endpoint, error, labels } = input;
  const title = labels.failedToConnect(endpoint);

  const raw = (() => {
    if (error instanceof DaemonConnectionTestError) {
      return (
        formatTechnicalTransportDetails([error.reason, error.lastError], labels) ??
        normalizeTransportMessage(error.message)
      );
    }
    if (error instanceof Error) {
      return normalizeTransportMessage(error.message);
    }
    return null;
  })();

  const rawLower = raw?.toLowerCase() ?? "";
  let detail: string | null = null;

  if (raw === "Incorrect password" || raw === "Password required") {
    detail = raw;
  } else if (rawLower.includes("timed out")) {
    detail = labels.timedOut;
  } else if (
    rawLower.includes("econnrefused") ||
    rawLower.includes("connection refused") ||
    rawLower.includes("err_connection_refused")
  ) {
    detail = labels.refused;
  } else if (rawLower.includes("enotfound") || rawLower.includes("not found")) {
    detail = labels.hostNotFound;
  } else if (rawLower.includes("ehostunreach") || rawLower.includes("host is unreachable")) {
    detail = labels.hostUnreachable;
  } else if (
    rawLower.includes("certificate") ||
    rawLower.includes("tls") ||
    rawLower.includes("ssl")
  ) {
    detail = labels.tlsError;
  } else {
    detail = labels.unableToConnect;
  }

  return { title, detail, raw };
}

export interface AddHostModalProps {
  visible: boolean;
  onClose: () => void;
  onCancel?: () => void;
  onSaved?: (result: {
    profile: HostProfile;
    serverId: string;
    hostname: string | null;
    isNewHost: boolean;
  }) => void;
}

export function AddHostModal({ visible, onClose, onCancel, onSaved }: AddHostModalProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const daemons = useHosts();
  const { probeAndUpsertDirectConnection } = useHostMutations();
  const { pickFiles } = useFilePicker();
  const isMobile = useIsCompactFormFactor();

  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("6767");
  const [useTls, setUseTls] = useState(false);
  const [password, setPassword] = useState("");
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [useMtls, setUseMtls] = useState(false);
  const [pkcs12Password, setPkcs12Password] = useState("");
  const [importedMtlsIdentity, setImportedMtlsIdentity] = useState<MtlsIdentityMetadata | null>(null);
  const [isImportingCertificate, setIsImportingCertificate] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [advancedUri, setAdvancedUri] = useState("");
  const [inputResetKey, bumpInputResetKey] = useReducer((key: number) => key + 1, 0);
  const importedMtlsIdentityIdsRef = useRef<string[]>([]);

  const isMtlsUiAvailable = Platform.OS === "ios" && isMtlsWebSocketAvailable();

  const clearInput = useCallback(() => {
    setHost("");
    setPort("6767");
    setUseTls(false);
    setPassword("");
    setIsPasswordVisible(false);
    setUseMtls(false);
    setPkcs12Password("");
    setImportedMtlsIdentity(null);
    setIsImportingCertificate(false);
    setIsAdvancedOpen(false);
    setAdvancedUri("");
    bumpInputResetKey();
  }, []);

  const cleanupDraftMtlsIdentities = useCallback(async (preserveIdentityId?: string | null) => {
    const trackedIdentityIds = [...new Set(importedMtlsIdentityIdsRef.current)];
    importedMtlsIdentityIdsRef.current = [];
    if (trackedIdentityIds.length === 0) {
      return;
    }
    await Promise.allSettled(
      trackedIdentityIds
        .filter((identityId) => identityId !== preserveIdentityId)
        .map((identityId) => deleteMtlsIdentity(identityId)),
    );
  }, []);

  const resetDraftAndClose = useCallback(
    async (preserveIdentityId?: string | null, close: () => void = onClose) => {
      await cleanupDraftMtlsIdentities(preserveIdentityId);
      clearInput();
      setErrorMessage("");
      close();
    },
    [cleanupDraftMtlsIdentities, clearInput, onClose],
  );

  const connectIcon = useMemo(
    () => <Link2 size={16} color={theme.colors.accentForeground} />,
    [theme.colors.accentForeground],
  );
  const hostFieldStyle = useMemo(() => [styles.field, styles.hostField], []);
  const portFieldStyle = useMemo(() => [styles.field, styles.portField], []);
  const checkboxStyle = useMemo(
    () => [styles.checkbox, useTls ? styles.checkboxChecked : null],
    [useTls],
  );
  const passwordInputStyle = useMemo(() => [styles.input, styles.passwordInput], []);
  const useTlsAccessibilityState = useMemo(
    () => ({ checked: useTls, disabled: isSaving }),
    [isSaving, useTls],
  );
  const directConnectionLabels = useMemo<DirectConnectionLabels>(
    () => ({
      hostRequired: t("pairing.direct.errors.hostRequired"),
      invalidPort: t("pairing.direct.errors.invalidPort"),
      invalidConnection: t("pairing.direct.errors.invalidConnection"),
      failedToConnect: (endpoint) => t("pairing.direct.errors.failedToConnect", { endpoint }),
      noAdditionalDetails: (detail) => t("pairing.direct.errors.noAdditionalDetails", { detail }),
      timedOut: t("pairing.direct.errors.timedOut"),
      refused: t("pairing.direct.errors.refused"),
      hostNotFound: t("pairing.direct.errors.hostNotFound"),
      hostUnreachable: t("pairing.direct.errors.hostUnreachable"),
      tlsError: t("pairing.direct.errors.tlsError"),
      unableToConnect: t("pairing.direct.errors.unableToConnect"),
    }),
    [t],
  );
  const header = useMemo<SheetHeader>(() => ({ title: t("pairing.direct.title") }), [t]);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    void resetDraftAndClose();
  }, [isSaving, resetDraftAndClose]);

  const handleCancel = useCallback(() => {
    if (isSaving) return;
    void resetDraftAndClose(null, onCancel ?? onClose);
  }, [isSaving, onCancel, onClose, resetDraftAndClose]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;

    let connection: PreparedDirectConnection;
    try {
      connection = prepareDirectConnection(
        {
          host,
          port,
          useTls,
          password,
          ...(useMtls && importedMtlsIdentity ? { mtls: importedMtlsIdentity } : {}),
        },
        directConnectionLabels,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : directConnectionLabels.invalidConnection;
      setErrorMessage(message);
      return;
    }

    if (useMtls && !isMtlsUiAvailable) {
      setErrorMessage("Client certificates are only available in the iOS app.");
      return;
    }
    if (useMtls && !useTls) {
      setErrorMessage("Client certificates require TLS.");
      return;
    }
    if (useMtls && !importedMtlsIdentity) {
      setErrorMessage("Import a .p12 or .pfx client certificate before connecting.");
      return;
    }

    try {
      setIsSaving(true);
      setErrorMessage("");

      const { profile, serverId, hostname } = await probeAndUpsertDirectConnection({
        endpoint: connection.endpoint,
        useTls: connection.useTls,
        ...(connection.password ? { password: connection.password } : {}),
        ...(connection.mtls ? { mtls: connection.mtls } : {}),
      });
      const isNewHost = !daemons.some((daemon) => daemon.serverId === serverId);

      onSaved?.({ profile, serverId, hostname, isNewHost });
      await resetDraftAndClose(importedMtlsIdentity?.identityId ?? null);
    } catch (error) {
      const {
        title,
        detail,
        raw: rawDetail,
      } = buildConnectionFailureCopy({
        endpoint: connection.uri,
        error,
        labels: directConnectionLabels,
      });
      let combined: string;
      if (rawDetail && detail && rawDetail !== detail) {
        combined = `${title}\n${detail}\n${t("pairing.direct.errors.details", {
          detail: rawDetail,
        })}`;
      } else if (detail) {
        combined = `${title}\n${detail}`;
      } else {
        combined = title;
      }
      setErrorMessage(combined);
      if (!isMobile) {
        Alert.alert(t("pairing.direct.errors.failedTitle"), combined);
      }
    } finally {
      setIsSaving(false);
    }
  }, [
    daemons,
    directConnectionLabels,
    host,
    importedMtlsIdentity,
    isMobile,
    isMtlsUiAvailable,
    isSaving,
    onSaved,
    password,
    port,
    probeAndUpsertDirectConnection,
    resetDraftAndClose,
    t,
    useMtls,
    useTls,
  ]);

  const handleSubmitEditing = useCallback(() => {
    void handleSave();
  }, [handleSave]);

  const handleSavePress = useCallback(() => {
    void handleSave();
  }, [handleSave]);

  const handleToggleUseTls = useCallback(() => {
    if (isSaving) return;
    setUseTls((current) => {
      const next = !current;
      if (!next) {
        setUseMtls(false);
        setPkcs12Password("");
        setImportedMtlsIdentity(null);
        void cleanupDraftMtlsIdentities();
      }
      return next;
    });
  }, [cleanupDraftMtlsIdentities, isSaving]);

  const handleTogglePasswordVisibility = useCallback(() => {
    setIsPasswordVisible((current) => !current);
  }, []);

  const handleToggleUseMtls = useCallback(() => {
    if (isSaving || isImportingCertificate) {
      return;
    }
    setUseMtls((current) => {
      const next = !current;
      if (!next) {
        setPkcs12Password("");
        setImportedMtlsIdentity(null);
        void cleanupDraftMtlsIdentities();
      }
      return next;
    });
  }, [cleanupDraftMtlsIdentities, isImportingCertificate, isSaving]);

  const handleImportMtlsCertificate = useCallback(async () => {
    if (!isMtlsUiAvailable || isSaving || isImportingCertificate) {
      return;
    }
    const trimmedPassword = pkcs12Password.trim();
    if (!trimmedPassword) {
      setErrorMessage("Enter the PKCS#12 password before importing.");
      return;
    }
    const selection = await pickFiles();
    const file = selection?.[0] ?? null;
    if (!file) {
      return;
    }
    if ((selection?.length ?? 0) !== 1 || !isPkcs12FileName(file.fileName)) {
      setErrorMessage("Choose a .p12 or .pfx client certificate file.");
      return;
    }

    try {
      setIsImportingCertificate(true);
      setErrorMessage("");
      const identity = await importMtlsPkcs12Identity({
        bytes: file.bytes,
        password: trimmedPassword,
        fileName: file.fileName,
      });
      importedMtlsIdentityIdsRef.current.push(identity.identityId);
      if (importedMtlsIdentity?.identityId) {
        importedMtlsIdentityIdsRef.current = importedMtlsIdentityIdsRef.current.filter(
          (identityId) => identityId !== importedMtlsIdentity.identityId,
        );
        await deleteMtlsIdentity(importedMtlsIdentity.identityId).catch(() => undefined);
      }
      setImportedMtlsIdentity(identity);
      setUseMtls(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to import the client certificate.");
    } finally {
      setIsImportingCertificate(false);
    }
  }, [
    importedMtlsIdentity,
    isImportingCertificate,
    isMtlsUiAvailable,
    isSaving,
    pickFiles,
    pkcs12Password,
  ]);

  const handleRemoveMtlsCertificate = useCallback(async () => {
    if (!importedMtlsIdentity || isSaving || isImportingCertificate) {
      return;
    }
    const identityId = importedMtlsIdentity.identityId;
    importedMtlsIdentityIdsRef.current = importedMtlsIdentityIdsRef.current.filter(
      (candidateId) => candidateId !== identityId,
    );
    setImportedMtlsIdentity(null);
    try {
      await deleteMtlsIdentity(identityId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to remove the client certificate.");
    }
  }, [importedMtlsIdentity, isImportingCertificate, isSaving]);

  const handleToggleAdvanced = useCallback(() => {
    if (!isAdvancedOpen) {
      try {
        setAdvancedUri(
          buildConnectionUriFromDraft({ host, port, useTls, password }, directConnectionLabels),
        );
      } catch {
        setAdvancedUri("");
      }
      setErrorMessage("");
      setIsAdvancedOpen(true);
      return;
    }

    try {
      const next = draftFromConnectionUri(advancedUri);
      setHost(next.host);
      setPort(next.port);
      setUseTls(next.useTls);
      setPassword(next.password);
      setErrorMessage("");
      bumpInputResetKey();
    } catch {
      setErrorMessage("");
    }
    setIsAdvancedOpen(false);
  }, [advancedUri, directConnectionLabels, host, isAdvancedOpen, password, port, useTls]);

  const AdvancedIcon = isAdvancedOpen ? ChevronDown : ChevronRight;
  const PasswordIcon = isPasswordVisible ? EyeOff : Eye;

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={handleClose}
      testID="add-host-modal"
    >
      <Text style={styles.helper}>{t("pairing.direct.helper")}</Text>

      <View style={styles.portRow}>
        <View style={hostFieldStyle}>
          <Text style={styles.label}>{t("pairing.direct.fields.host")}</Text>
          <AdaptiveTextInput
            testID="direct-host-input"
            nativeID="direct-host-input"
            accessibilityLabel={t("pairing.direct.fields.host")}
            initialValue={host}
            resetKey={`direct-host-${inputResetKey}`}
            value={host}
            onChangeText={setHost}
            placeholder="localhost"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!isSaving}
            returnKeyType="next"
          />
        </View>
        <View style={portFieldStyle}>
          <Text style={styles.label}>{t("pairing.direct.fields.port")}</Text>
          <AdaptiveTextInput
            testID="direct-port-input"
            nativeID="direct-port-input"
            accessibilityLabel={t("pairing.direct.fields.port")}
            initialValue={port}
            resetKey={`direct-port-${inputResetKey}`}
            value={port}
            onChangeText={setPort}
            placeholder="6767"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="number-pad"
            editable={!isSaving}
            returnKeyType="done"
            onSubmitEditing={handleSubmitEditing}
          />
        </View>
      </View>

      <Pressable
        style={styles.checkboxRow}
        onPress={handleToggleUseTls}
        disabled={isSaving}
        accessibilityRole="checkbox"
        accessibilityLabel={t("pairing.direct.fields.useSsl")}
        accessibilityState={useTlsAccessibilityState}
        testID="direct-ssl-toggle"
      >
        <View style={checkboxStyle}>
          {useTls ? (
            <View testID="direct-ssl-toggle-checked">
              <Check size={14} color={theme.colors.accentForeground} />
            </View>
          ) : null}
        </View>
        <Text style={styles.label}>{t("pairing.direct.fields.useSsl")}</Text>
      </Pressable>

      <View style={styles.field}>
        <Text style={styles.label}>{t("pairing.direct.fields.password")}</Text>
        <View style={styles.passwordRow}>
          <AdaptiveTextInput
            testID="direct-password-input"
            nativeID="direct-password-input"
            accessibilityLabel={t("pairing.direct.fields.password")}
            initialValue={password}
            resetKey={`direct-password-${inputResetKey}`}
            value={password}
            onChangeText={setPassword}
            placeholder={t("pairing.direct.fields.optional")}
            placeholderTextColor={theme.colors.foregroundMuted}
            style={passwordInputStyle}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry={!isPasswordVisible}
            editable={!isSaving}
            returnKeyType="done"
            onSubmitEditing={handleSubmitEditing}
          />
          <Pressable
            style={styles.iconButton}
            onPress={handleTogglePasswordVisibility}
            disabled={isSaving}
            accessibilityRole="button"
            accessibilityLabel={
              isPasswordVisible
                ? t("pairing.direct.passwordVisibility.hide")
                : t("pairing.direct.passwordVisibility.show")
            }
            testID="direct-password-visibility-toggle"
          >
            <PasswordIcon size={18} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      </View>

      {useTls && isMtlsUiAvailable ? (
        <View style={styles.field}>
          <Pressable
            style={styles.checkboxRow}
            onPress={handleToggleUseMtls}
            disabled={isSaving || isImportingCertificate}
            accessibilityRole="checkbox"
            accessibilityLabel="Use client certificate"
            accessibilityState={{ checked: useMtls, disabled: isSaving || isImportingCertificate }}
            testID="direct-mtls-toggle"
          >
            <View style={[styles.checkbox, useMtls ? styles.checkboxChecked : null]}>
              {useMtls ? <Check size={14} color={theme.colors.accentForeground} /> : null}
            </View>
            <Text style={styles.label}>Use client certificate</Text>
          </Pressable>
          {useMtls ? (
            <>
              <Text style={styles.helper}>
                Import a PKCS#12 (.p12 or .pfx) client certificate for mutual TLS.
              </Text>
              <AdaptiveTextInput
                testID="direct-mtls-password-input"
                nativeID="direct-mtls-password-input"
                accessibilityLabel="Certificate password"
                initialValue={pkcs12Password}
                resetKey={`direct-mtls-password-${inputResetKey}`}
                value={pkcs12Password}
                onChangeText={setPkcs12Password}
                placeholder="Certificate password"
                placeholderTextColor={theme.colors.foregroundMuted}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                editable={!isSaving && !isImportingCertificate}
                returnKeyType="done"
              />
              <View style={styles.certificateActions}>
                <Button
                  variant="secondary"
                  onPress={() => {
                    void handleImportMtlsCertificate();
                  }}
                  disabled={isSaving || isImportingCertificate}
                  testID="direct-mtls-import"
                >
                  {importedMtlsIdentity ? "Replace .p12" : "Import .p12"}
                </Button>
                {importedMtlsIdentity ? (
                  <Button
                    variant="secondary"
                    onPress={() => {
                      void handleRemoveMtlsCertificate();
                    }}
                    disabled={isSaving || isImportingCertificate}
                    testID="direct-mtls-remove"
                  >
                    Remove certificate
                  </Button>
                ) : null}
              </View>
              {importedMtlsIdentity ? (
                <View style={styles.certificateCard}>
                  <Text style={styles.certificateTitle}>Imported certificate</Text>
                  {importedMtlsIdentity.displayName ? (
                    <Text style={styles.certificateDetail}>{importedMtlsIdentity.displayName}</Text>
                  ) : null}
                  {importedMtlsIdentity.subjectSummary ? (
                    <Text style={styles.certificateDetail}>{importedMtlsIdentity.subjectSummary}</Text>
                  ) : null}
                  {importedMtlsIdentity.expiresAt ? (
                    <Text style={styles.certificateDetail}>Expires {importedMtlsIdentity.expiresAt}</Text>
                  ) : null}
                </View>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}

      <View style={styles.field}>
        <Pressable
          style={styles.advancedToggle}
          onPress={handleToggleAdvanced}
          disabled={isSaving}
          accessibilityRole="button"
          accessibilityLabel={
            isAdvancedOpen ? t("pairing.direct.advanced.hide") : t("pairing.direct.advanced.show")
          }
          testID="direct-host-advanced-toggle"
        >
          <AdvancedIcon size={16} color={theme.colors.foregroundMuted} />
          <Text style={styles.advancedText}>{t("pairing.direct.advanced.label")}</Text>
        </Pressable>
        {isAdvancedOpen ? (
          <AdaptiveTextInput
            testID="direct-host-uri-input"
            nativeID="direct-host-uri-input"
            accessibilityLabel={t("pairing.direct.fields.connectionUri")}
            initialValue={advancedUri}
            resetKey={`direct-host-uri-${inputResetKey}`}
            value={advancedUri}
            onChangeText={setAdvancedUri}
            placeholder="tcp://localhost:6767?ssl=true"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            editable={!isSaving}
            returnKeyType="done"
            onSubmitEditing={handleToggleAdvanced}
          />
        ) : null}
        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      </View>

      <View style={styles.actions}>
        <Button
          style={FLEX_ONE_STYLE}
          variant="secondary"
          onPress={handleCancel}
          disabled={isSaving}
        >
          {t("pairing.direct.actions.cancel")}
        </Button>
        <Button
          style={FLEX_ONE_STYLE}
          variant="default"
          onPress={handleSavePress}
          disabled={isSaving}
          leftIcon={connectIcon}
          testID="direct-host-submit"
        >
          {isSaving ? t("pairing.direct.actions.connecting") : t("pairing.direct.actions.connect")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}
