import { useState, useEffect, useCallback } from "react";
import type { PresetTimeRange, TimeRange } from "../types";
import { getProfileAccessPoints } from "../../../services";
import type { AccessPoint } from "../../../services";

export function useLogFilters(profileId: string) {
  const [range, setRangeState] = useState<TimeRange>("1h");
  const [baseRange, setBaseRange] = useState<PresetTimeRange>("1h");
  const [customRange, setCustomRange] = useState({ start: "", end: "" });

  const setRange = useCallback((nextRange: TimeRange) => {
    if (nextRange !== "custom") {
      setBaseRange(nextRange);
    }
    setRangeState(nextRange);
  }, []);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [accessPointIdFilter, setAccessPointIdFilter] = useState<string | null>(null);
  const [accessPoints, setAccessPoints] = useState<AccessPoint[]>([]);
  const [destCountryFilter, setDestCountryFilterState] = useState<string | null>(null);
  const [ispFilter, setIspFilter] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    getProfileAccessPoints(profileId)
      .then(setAccessPoints)
      .catch(console.error);
  }, [profileId]);

  // Reset ISP filter atomically with destination country change so useLogsFetcher fires once instead of twice
  const setDestCountryFilter = useCallback((nextCountry: string | null) => {
    setDestCountryFilterState(nextCountry);
    setIspFilter(null);
  }, []);

  return {
    range,
    baseRange,
    setRange,
    customRange,
    setCustomRange,
    statusFilter,
    setStatusFilter,
    accessPointIdFilter,
    setAccessPointIdFilter,
    accessPoints,
    destCountryFilter,
    setDestCountryFilter,
    ispFilter,
    setIspFilter,
    searchQuery,
    setSearchQuery,
  };
}
