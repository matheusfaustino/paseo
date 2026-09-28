import { useCallback, useRef } from "react";
import * as ImagePicker from "expo-image-picker";
import { useTranslation } from "react-i18next";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import {
  normalizePickedImageAssets,
  pickImagesWithDesktopDialog,
  type PickedImageAttachmentInput,
} from "@/hooks/image-attachment-picker";
import { isWeb } from "@/constants/platform";

interface UseImageAttachmentPickerResult {
  pickImages: () => Promise<PickedImageAttachmentInput[] | null>;
  takePhoto: () => Promise<PickedImageAttachmentInput[] | null>;
}

function usePermissionGate(
  permission: ImagePicker.PermissionResponse | null,
  requestPermission: () => Promise<ImagePicker.PermissionResponse>,
  errorMessage: string,
  onError: (message: string) => void,
) {
  return useCallback(async () => {
    let currentPermission = permission;

    if (
      !currentPermission ||
      currentPermission.status === ImagePicker.PermissionStatus.UNDETERMINED
    ) {
      currentPermission = await requestPermission();
    } else if (!currentPermission.granted) {
      currentPermission = await requestPermission();
    }

    if (!currentPermission?.granted) {
      onError(errorMessage);
      return false;
    }

    return true;
  }, [permission, requestPermission, errorMessage, onError]);
}

export function useImageAttachmentPicker(
  onError: (message: string) => void,
): UseImageAttachmentPickerResult {
  const { t } = useTranslation();
  const [mediaPermission, requestMediaPermission] = ImagePicker.useMediaLibraryPermissions();
  const [cameraPermission, requestCameraPermission] = ImagePicker.useCameraPermissions();
  const isPickingRef = useRef(false);

  const ensurePermission = usePermissionGate(
    mediaPermission,
    requestMediaPermission,
    t("imageAttachmentPicker.permissionMessage"),
    onError,
  );
  const ensureCameraPermission = usePermissionGate(
    cameraPermission,
    requestCameraPermission,
    t("imageAttachmentPicker.cameraPermissionMessage"),
    onError,
  );

  const pickImages = useCallback(async () => {
    if (isPickingRef.current) {
      return null;
    }

    isPickingRef.current = true;

    try {
      if (isWeb && isElectronRuntime()) {
        const selectedImages = await pickImagesWithDesktopDialog(getDesktopHost()?.dialog);
        if (selectedImages.length === 0) {
          return null;
        }
        return selectedImages;
      }

      const hasPermission = await ensurePermission();
      if (!hasPermission) {
        return null;
      }

      const pendingResult = await ImagePicker.getPendingResultAsync();
      if (pendingResult && "canceled" in pendingResult && !pendingResult.canceled) {
        return await normalizePickedImageAssets(pendingResult.assets);
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"] as ImagePicker.MediaType[],
        allowsMultipleSelection: true,
        quality: 0.8,
      });

      if (result.canceled) {
        return null;
      }

      return await normalizePickedImageAssets(result.assets);
    } catch (error) {
      console.error("[ImageAttachmentPicker] Failed to pick image:", error);
      onError(t("imageAttachmentPicker.failedToSelect"));
      return null;
    } finally {
      isPickingRef.current = false;
    }
  }, [ensurePermission, onError, t]);

  const takePhoto = useCallback(async () => {
    if (isPickingRef.current) {
      return null;
    }

    isPickingRef.current = true;

    try {
      const hasPermission = await ensureCameraPermission();
      if (!hasPermission) {
        return null;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"] as ImagePicker.MediaType[],
        quality: 0.8,
      });

      if (result.canceled) {
        return null;
      }

      return await normalizePickedImageAssets(result.assets);
    } catch (error) {
      console.error("[ImageAttachmentPicker] Failed to take photo:", error);
      onError(t("imageAttachmentPicker.failedToCapture"));
      return null;
    } finally {
      isPickingRef.current = false;
    }
  }, [ensureCameraPermission, onError, t]);

  return { pickImages, takePhoto };
}
