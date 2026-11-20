import React, { useEffect, useState, useMemo, useCallback } from "react";
import { Intent, Callout, Button, Spinner } from "@blueprintjs/core";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Settings2 } from "lucide-react";
import { setSystemTimeZone } from "../../utils/date";

import type { SetupViewProps, ClientInfo } from "./types";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useDeploymentMode } from "../../hooks/useDeploymentMode";
import { SetupHeader } from "./components/SetupHeader";
import { VerifyConnectionCard } from "./components/VerifyConnectionCard";
import { AccessPointCard } from "./components/AccessPointCard";
import { DohUrlCard } from "./components/DohUrlCard";
import { SetupTabs } from "./components/SetupTabs";
import type { AccessPoint } from "../../types/auth";
import {
  getClientInfo,
  getTraceInfo,
  getSubstituteInfo,
  getAccessPoints,
  getDomainGeoLocation,
  resolveDomainDnsIps,
  isDummyOrPlaceholderDomain,
} from "../../services";

export const SetupView: React.FC<SetupViewProps> = ({ profiles, toasterRef }) => {
  const isMobile = useIsMobile();
  const { isServerfull } = useDeploymentMode();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [accessPoints, setAccessPoints] = useState<AccessPoint[]>([]);
  const [loadingAccessPoints, setLoadingAccessPoints] = useState(true);
  const [selectedApId, setSelectedApId] = useState<string | null>(() => searchParams.get("ap"));
  const [apSwitchCount, setApSwitchCount] = useState(0);

  const handleSelectAp = (id: string) => {
    if (id === selectedApId) return;
    setSelectedApId(id);
    setApSwitchCount((count) => count + 1);
    setSearchParams({ ap: id }, { replace: true });
  };

  const fetchAccessPoints = useCallback(async () => {
    setLoadingAccessPoints(true);
    try {
      const data = await getAccessPoints();
      setAccessPoints(data);
    } catch (e) {
      console.error("Failed to fetch access points:", e);
    } finally {
      setLoadingAccessPoints(false);
    }
  }, []);

  useEffect(() => {
    void fetchAccessPoints();
  }, [fetchAccessPoints]);

  const activeAp = useMemo(() => {
    if (accessPoints.length === 0) return null;
    return accessPoints.find((ap) => ap.id === selectedApId) || accessPoints[0];
  }, [accessPoints, selectedApId]);

  const boundProfile = useMemo(() => {
    if (!activeAp?.profile_id) return null;
    return profiles.find((p) => p.id === activeAp.profile_id) || null;
  }, [activeAp, profiles]);

  const activeToken = activeAp?.token || "";
  const activeName = activeAp?.name;
  const dohUrl = activeToken ? `${window.location.origin}/${activeToken}` : "";

  const [clientInfo, setClientInfo] = useState<ClientInfo | null>(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [showIp, setShowIp] = useState(false);
  const [showLocation, setShowLocation] = useState(false);
  const [traceInfo, setTraceInfo] = useState<{ colo: string; raw: string } | null>(null);
  const [edgeLocation, setEdgeLocation] = useState<string | null>(null);
  const [domainIps, setDomainIps] = useState<{ ipv4: string[]; ipv6: string[] }>({ ipv4: [], ipv6: [] });
  const [verifyResult, setVerifyResult] = useState<{ success: boolean; profileMatch: boolean } | null>(null);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toasterRef?.current?.show({
      message: t("setup.copied"),
      intent: Intent.SUCCESS,
    });
  };

  const handleVerify = useCallback(async (targetProfileId?: string | null) => {
    setIsVerifying(true);
    setVerifyResult(null);
    try {
      const [clientData, traceResult] = await Promise.all([
        getClientInfo(),
        isServerfull ? Promise.resolve(null) : getTraceInfo(),
      ]);

      // Fallback GeoIP lookup if country or city is unknown for a public IP
      const isPrivateNetwork = clientData.country === "Private Network";
      const needsGeoFallback =
        clientData.country === "UNKNOWN" ||
        !clientData.country ||
        (!isPrivateNetwork && (clientData.city === "UNKNOWN" || !clientData.city));
      if (clientData.ip && needsGeoFallback) {
        try {
          const fallbackRes = await fetch(`/api/geoip?ip=${encodeURIComponent(clientData.ip)}`);
          if (fallbackRes.ok) {
            const fallbackGeo = await fallbackRes.json();
            if (fallbackGeo.success) {
              if (fallbackGeo.country) clientData.country = fallbackGeo.country;
              if (fallbackGeo.region) clientData.region = fallbackGeo.region;
              if (fallbackGeo.city) clientData.city = fallbackGeo.city;
              if (fallbackGeo.timezone?.id) clientData.timezone = fallbackGeo.timezone.id;
              if (fallbackGeo.connection?.org) clientData.asOrganization = fallbackGeo.connection.org;
            }
          }
        } catch {
          // Ignore fallback errors
        }
      }

      setClientInfo(clientData);
      setTraceInfo(traceResult);

      if (clientData.timezone && clientData.timezone !== "UNKNOWN") {
        setSystemTimeZone(clientData.timezone);
      }

      const isLocalHost =
        window.location.hostname === "localhost" ||
        window.location.hostname === "127.0.0.1" ||
        window.location.hostname === "::1" ||
        window.location.hostname.startsWith("192.168.") ||
        window.location.hostname.startsWith("10.") ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(window.location.hostname);

      const hasValidDotDomain = Boolean(
        clientData.dotDomain && !isDummyOrPlaceholderDomain(clientData.dotDomain)
      );

      const domainToResolve =
        isLocalHost && hasValidDotDomain
          ? clientData.dotDomain!
          : hasValidDotDomain
            ? clientData.dotDomain!
            : window.location.hostname || "";

      getDomainGeoLocation(domainToResolve)
        .then((loc) => setEdgeLocation(loc))
        .catch((e) => console.warn("Failed fetching domain geo location:", e));

      const targetSubstituteDomain = clientData.substituteDomain || "www.wto.org";
      getSubstituteInfo()
        .then((sub) => {
          setDomainIps((prev) => {
            if (prev.ipv4.length > 0 || prev.ipv6.length > 0) return prev;
            return {
              ipv4: sub.ip ? [sub.ip] : [],
              ipv6: sub.ipv6 ? [sub.ipv6] : [],
            };
          });
        })
        .catch(() => {});

      resolveDomainDnsIps(targetSubstituteDomain)
        .then((ips) => {
          if (ips.ipv4.length > 0 || ips.ipv6.length > 0) {
            setDomainIps(ips);
          }
        })
        .catch((e) => console.warn("Failed resolving substitute domain DNS IPs:", e));

      setVerifyResult({
        success: Boolean(clientData.connectedProfileId),
        profileMatch: Boolean(
          targetProfileId && clientData.connectedProfileId === targetProfileId
        ),
      });
    } catch (e) {
      console.error("Verification failed", e);
    } finally {
      setIsVerifying(false);
    }
  }, [isServerfull]);

  useEffect(() => {
    void handleVerify(activeAp?.profile_id || null);
  }, [activeAp?.id, activeAp?.profile_id, handleVerify]);

  const currentIps = useMemo(() => {
    const list: { ip: string; area: string | null }[] = [];
    const v4 = (domainIps.ipv4 || []).slice(0, 2);
    const v6 = (domainIps.ipv6 || []).slice(0, 2);
    const domainLabel = clientInfo?.substituteDomain || "www.wto.org";

    for (const ip of v4) {
      list.push({
        ip,
        area: `${domainLabel} IPv4`,
      });
    }
    for (const ip of v6) {
      list.push({
        ip,
        area: `${domainLabel} IPv6`,
      });
    }

    return list;
  }, [domainIps, clientInfo?.substituteDomain]);

  return (
    <div className={`mx-auto space-y-8 pb-24 ${isMobile ? "p-1" : "px-8 max-w-5xl"}`}>
      <SetupHeader isMobile={isMobile} />

      <VerifyConnectionCard
        isVerifying={isVerifying}
        verifyResult={verifyResult}
        handleVerify={() => void handleVerify(activeAp?.profile_id || null)}
        isMobile={isMobile}
        clientInfo={clientInfo}
        showIp={showIp}
        setShowIp={setShowIp}
        showLocation={showLocation}
        setShowLocation={setShowLocation}
        traceInfo={traceInfo}
        edgeLocation={edgeLocation}
      />

      {loadingAccessPoints ? (
        <div className="flex justify-center p-8">
          <Spinner size={28} />
        </div>
      ) : accessPoints.length === 0 ? (
        <Callout
          intent={Intent.WARNING}
          title={t("setup.noAccessPoints", "No access points found")}
          className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
        >
          <span>
            {t(
              "setup.createAccessPointHint",
              "Create an Access Point first and bind it to a Profile to obtain endpoint credentials."
            )}
          </span>
          <Button
            intent={Intent.PRIMARY}
            icon={<Settings2 size={14} />}
            text={t("setup.manageAccessPoints")}
            onClick={() => navigate("/access-points/manage")}
            className="shrink-0 mt-2 sm:mt-0"
          />
        </Callout>
      ) : (
        <>
          <AccessPointCard
            accessPoints={accessPoints}
            selectedAp={activeAp}
            onSelectAp={handleSelectAp}
          />

          {activeAp && !activeAp.profile_id && (
            <Callout
              intent={Intent.WARNING}
              title={t("setup.unboundProfileWarningTitle", "Access Point Unbound")}
              className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4"
            >
              <span>
                {t(
                  "setup.unboundProfileWarningDesc",
                  "This Access Point is not currently bound to any Profile. DNS queries using it fall back to Fail-Open upstream without filtering or logging. Manage bindings in Access Points -> Manage."
                )}
              </span>
              <Button
                intent={Intent.WARNING}
                variant="outlined"
                icon={<Settings2 size={14} />}
                text={t("setup.manageAccessPoints")}
                onClick={() => navigate("/access-points/manage")}
                className="shrink-0 mt-2 sm:mt-0"
              />
            </Callout>
          )}

          {activeToken && (
            <>
              <DohUrlCard
                dohUrl={dohUrl}
                copyToClipboard={copyToClipboard}
                isMobile={isMobile}
                flashTrigger={apSwitchCount}
              />

              <SetupTabs
                isMobile={isMobile}
                copyToClipboard={copyToClipboard}
                dohUrl={dohUrl}
                profileKey={activeToken}
                profileName={boundProfile?.name}
                accessPointName={activeName}
                currentIps={currentIps}
                dotDomain={clientInfo?.dotDomain}
              />
            </>
          )}
        </>
      )}
    </div>
  );
};
