import { Browser } from "@capacitor/browser";
import { Capacitor } from "@capacitor/core";

export async function openDownloadUrl(baseUrl: string, downloadUrl: string): Promise<void> {
  const url = new URL(downloadUrl, `${baseUrl}/`).toString();
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url });
    return;
  }
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}
