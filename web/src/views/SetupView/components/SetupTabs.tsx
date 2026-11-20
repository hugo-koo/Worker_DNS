import React from "react";
import { Tabs, Tab, H5, Button, Icon, Intent, Tag, Callout } from "@blueprintjs/core";
import { Globe, AppWindowMac, Monitor, Terminal, Smartphone, Router, ExternalLink } from "lucide-react";
import { clsx } from "clsx";
import { useTranslation } from "react-i18next";
import { generateMobileConfig, formatProfileLabel, extractDomain } from "../../../utils/mobileconfig";
import { StepStampWatermark } from "./StepStampWatermark";
import { useDeploymentMode, getDisplayOrigin, getDisplayHostname } from "../../../hooks/useDeploymentMode";
import { isDummyOrPlaceholderDomain } from "../../../services";
import type { SetupTabId } from "../../../constants/deviceTypes";

export interface SetupTabsProps {
  isMobile: boolean;
  copyToClipboard: (text: string) => void;
  dohUrl?: string;
  profileKey: string;
  profileName?: string;
  accessPointName?: string;
  currentIps: { ip: string; area: string | null }[];
  dotDomain?: string;
  selectedTabId?: SetupTabId;
  onTabChange?: (tabId: SetupTabId) => void;
}

const DOH_URL_PLACEHOLDER_TOKEN = "__DNS_WORKER_DOH_URL__";

export const SetupTabs: React.FC<SetupTabsProps> = ({
  isMobile,
  copyToClipboard,
  dohUrl,
  profileKey,
  profileName,
  accessPointName,
  currentIps,
  dotDomain,
  selectedTabId,
  onTabChange,
}) => {
  const { t } = useTranslation();
  const { isCloudflare, isDemoMode, demoDomain } = useDeploymentMode();
  const displayOrigin = getDisplayOrigin(isDemoMode, demoDomain);
  const displayHostname = getDisplayHostname(isDemoMode, demoDomain);
  const resolvedDohUrl = dohUrl || `${displayOrigin}/${profileKey}`;

  /**
   * Renders a localized setup instruction while replacing the `{{dohUrl}}` placeholder
   * with a clickable, copy-to-clipboard Access DoH URL code badge.
   */
  const renderStepWithDohUrl = (translationKey: string): React.ReactNode => {
    const rendered = t(translationKey, { dohUrl: DOH_URL_PLACEHOLDER_TOKEN });
    const parts = rendered.split(DOH_URL_PLACEHOLDER_TOKEN);
    if (parts.length === 1) {
      return rendered;
    }
    return parts.map((part, idx) => (
      <React.Fragment key={idx}>
        {part}
        {idx < parts.length - 1 && (
          <code
            onClick={() => copyToClipboard(resolvedDohUrl)}
            title={t("setup.copyUrl", "Copy URL")}
            className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-blue-600 dark:text-blue-400 font-mono text-xs cursor-pointer hover:underline break-all"
          >
            {resolvedDohUrl}
          </code>
        )}
      </React.Fragment>
    ));
  };

  return (
    <div className="group relative overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm">
      <StepStampWatermark step={3} />
      <Tabs
        id="setup-tabs"
        selectedTabId={selectedTabId}
        onChange={(newTabId) => onTabChange?.(String(newTabId) as SetupTabId)}
        renderActiveTabPanelOnly={true}
        vertical={!isMobile} // 移动端使用水平 Tab
        size="large"
        className={clsx(
          "p-4 md:p-6 setup-tabs-container relative z-10 bg-transparent",
          isMobile && [
            "[&_.bp6-tab-list]:overflow-x-auto!",
            "[&_.bp6-tab-list]:flex-nowrap!",
            "[&_.bp6-tab-list]:pb-1",
            "[&_.bp6-tab-list]:scrollbar-none",
            "[&_.bp6-tab-list]:[-ms-overflow-style:none]",
            "[&_.bp6-tab-list::-webkit-scrollbar]:hidden",
            "[&_.bp6-tab]:shrink-0",
          ]
        )}
      >
      <Tab
        id="browsers"
        title={
          <span>
            <Globe size={16} className="inline mr-2" />
            {t("setup.browsers")}
          </span>
        }
        panel={
          <div className="space-y-4 md:ml-4 mt-4 md:mt-0">
            <H5 className="font-bold">{t("setup.browserTitle")}</H5>
            <p className="text-sm">{renderStepWithDohUrl("setup.browserSteps")}</p>
            <p className="text-[10px] opacity-50 cursor-pointer" onClick={() => copyToClipboard("chrome://settings/security")}>
              {t("setup.browserTips", "or copy this URL to the address bar: ") + "chrome://settings/security"}
            </p>
          </div>
        }
      />

      <Tab
        id="apple"
        title={
          <span>
            <AppWindowMac size={16} className="inline mr-2" />
            {t("setup.apple")}
          </span>
        }
        panel={
          <div className="space-y-4 md:ml-4 mt-4 md:mt-0">
            <H5 className="font-bold">{t("setup.appleTitle")}</H5>
            <p className="text-sm">{t("setup.appleDesc")}</p>
            <p className="text-[10px] opacity-50 text-center">{t("setup.appleWarning")}</p>
            <div className="p-6 bg-gray-50 dark:bg-gray-800 rounded-xl border border-dashed border-gray-300 dark:border-gray-700 flex flex-col items-center justify-center">
              {accessPointName && (
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-1 max-w-full truncate">
                  {accessPointName}
                </span>
              )}
              <span
                className="font-mono text-xs opacity-75 mb-3 max-w-full truncate select-text"
                title={resolvedDohUrl}
              >
                {resolvedDohUrl}
              </span>
              <Icon icon="document" size={40} className="opacity-20 mb-4" />
              <Button
                intent={Intent.PRIMARY}
                text={t("setup.downloadConfig")}
                icon="download"
                onClick={() => {
                  const xml = generateMobileConfig({
                    profileKey,
                    profileName,
                    accessPointName,
                    origin: displayOrigin,
                  });
                  const blob = new Blob([xml], { type: "application/x-apple-aspen-config" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  const label = formatProfileLabel(profileName, accessPointName);
                  const domain = extractDomain(displayOrigin);
                  const fileTag = (label || domain)
                    .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, "_")
                    .replace(/_+/g, "_")
                    .replace(/^_|_$/g, "");
                  a.download = `dns_worker-${fileTag}-${profileKey}.mobileconfig`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              />
            </div>
            <p className="text-[10px] opacity-50 mt-4! text-center">{t("setup.appleInstallHint")}</p>
          </div>
        }
      />
      <Tab
        id="windows"
        title={
          <span>
            <Monitor size={16} className="inline mr-2" />
            {t("setup.windows")}
          </span>
        }
        panel={
          <div className="space-y-4 md:ml-4 mt-4 md:mt-0">
            <H5 className="font-bold">
              {t("setup.windowsTitle")}
            </H5>
            <ol className="list-decimal list-inside space-y-4 text-sm leading-relaxed">
              <li>
                <a href="ms-settings:network-status">{t("setup.windowsStep0")}</a>
              </li>
              <li>{t("setup.windowsStep1")}</li>
              <li>
                {t("setup.windowsStep2")}
                <div className="mt-2 flex flex-wrap gap-2">
                  {currentIps.map((item) => (
                    <div key={item.ip} className="flex flex-col gap-1">
                      <Tag minimal interactive onClick={() => copyToClipboard(item.ip)} icon="duplicate" className="font-mono">
                        {item.ip}
                      </Tag>
                      <span className="text-[9px] opacity-50 ml-1 font-mono">{item.area}</span>
                    </div>
                  ))}
                </div>
              </li>
              <li>{renderStepWithDohUrl("setup.windowsStep3")}</li>
              <li>{t("setup.windowsStep4")}</li>
            </ol>
          </div>
        }
      />

      <Tab
        id="linux"
        title={
          <span>
            <Terminal size={16} className="inline mr-2" />
            {t("setup.linux")}
          </span>
        }
        panel={
          <div className="space-y-4 md:ml-4 mt-4 md:mt-0">
            <H5 className="font-bold">{t("setup.linuxTitle")}</H5>
            <p className="text-sm">{t("setup.linuxDesc")}</p>

            <div className="mt-4">
              <p className="text-sm font-bold mb-2">{t("setup.linuxStep1")}</p>
              <div className="relative group">
                <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg overflow-x-auto text-xs font-mono border border-gray-200 dark:border-gray-700">
                  <code>{`curl -sL "${displayOrigin}/setup.sh?key=${profileKey}&origin=${displayOrigin}" | sudo bash`}</code>
                </pre>
                <Button
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                  icon="duplicate"
                  minimal
                  small
                  onClick={() => {
                    copyToClipboard(`curl -sL "${displayOrigin}/setup.sh?key=${profileKey}&origin=${displayOrigin}" | sudo bash`);
                  }}
                />
              </div>
            </div>

            <div className="mt-4">
              <p className="text-sm font-bold">{t("setup.linuxStep2")}</p>
            </div>
          </div>
        }
      />

      <Tab
        id="routeros"
        title={
          <span>
            <Router size={16} className="inline mr-2" />
            {t("setup.routeros")}
          </span>
        }
        panel={
          <div className="space-y-4 md:ml-4 mt-4 md:mt-0">
            <H5 className="font-bold">{t("setup.routerosTitle")}</H5>
            <p className="text-sm">{t("setup.routerosDesc")}</p>

            <div className="mt-4">
              <p className="text-sm font-bold mb-2">{t("setup.routerosStep1")}</p>
              <div className="relative group">
                <pre className="bg-gray-100 dark:bg-gray-800 p-4 rounded-lg overflow-x-auto text-xs font-mono border border-gray-200 dark:border-gray-700">
                  <code>{`/ip dns set use-doh-server="${displayOrigin}/${profileKey}" verify-doh-cert=yes`}</code>
                </pre>
                <Button
                  className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
                  icon="duplicate"
                  minimal
                  small
                  onClick={() => {
                    copyToClipboard(`/ip dns set use-doh-server="${displayOrigin}/${profileKey}" verify-doh-cert=yes`);
                  }}
                />
              </div>
            </div>

            <p className="text-sm">{t("setup.routerosNote")}</p>

            <a
              href="https://help.mikrotik.com/docs/spaces/ROS/pages/37748767/DNS"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 text-xs text-blue-500 hover:underline"
            >
              <ExternalLink size={10} /> {t("setup.routerosDocs")}
            </a>
          </div>
        }
      />

      <Tab
        id="android"
        title={
          <span>
            <Smartphone size={16} className="inline mr-2" />
            {t("setup.android")}
          </span>
        }
        panel={
          <div className="space-y-4 md:ml-4 mt-4 md:mt-0">
            <H5 className="font-bold">{t("setup.androidTitle")}</H5>
            <p className="text-sm">{t("setup.androidDesc")}</p>

            {isCloudflare ? (
              <Callout intent={Intent.WARNING} icon="warning-sign" className="text-xs">
                <div className="font-semibold mb-1">{t("setup.dotUnavailableCfTitle")}</div>
                <div>{t("setup.dotUnavailableCfDesc")}</div>
              </Callout>
            ) : (
              (() => {
                const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(displayHostname) ||
                                    displayHostname === "localhost" ||
                                    displayHostname === "127.0.0.1" ||
                                    displayHostname.includes(":");
                const cleanBaseDomain = (dotDomain || "").trim().replace(/^\*\./, "");
                const isDummy = isDummyOrPlaceholderDomain(cleanBaseDomain);
                const effectiveDotDomain = isDemoMode
                  ? demoDomain
                  : (!isDummy && cleanBaseDomain) || (!isIpAddress ? displayHostname : "");

                return (
                  <div className="p-4 bg-gray-50 dark:bg-gray-800/60 rounded-xl border border-gray-200 dark:border-gray-700 space-y-3">
                    <div className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                      {t("setup.androidDotTitle", "私有 DNS (DoT / DoQ)")}
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400">
                      {t("setup.androidDotDesc", "支持 Android 原生“私有 DNS (DoT)”及各类现代 DoQ 客户端。提供商主机名：")}
                    </p>

                    {effectiveDotDomain ? (
                      <div className="space-y-3 pt-1">
                        <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2">
                          <Tag
                            minimal
                            interactive
                            onClick={() => copyToClipboard(`${profileKey}.${effectiveDotDomain}`)}
                            icon="duplicate"
                            className="font-mono text-xs sm:text-sm py-1 px-3 self-start"
                            intent={Intent.PRIMARY}
                          >
                            {`${profileKey}.${effectiveDotDomain}`}
                          </Tag>
                        </div>
                      </div>
                    ) : (
                      <Callout intent={Intent.WARNING} icon="warning-sign" className="text-xs">
                        {t("setup.androidIpNotice", "检测到当前通过 IP 或本地地址访问面板。DoT / DoQ 仅接受域名，请在 .env 中配置 SERVERFULL_DOT_DOMAIN (例如 dns.example.com) 后刷新。")}
                      </Callout>
                    )}
                  </div>
                );
              })()
            )}

            {!isCloudflare && (
              <Callout intent={Intent.PRIMARY} icon="info-sign" className="text-xs">
                {t("setup.androidWarning")}
              </Callout>
            )}
          </div>
        }
      />
    </Tabs>
    </div>
  );
};
