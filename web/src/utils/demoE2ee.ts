const DEMO_E2EE_LOCKED_KEY = "dns_worker_demo_e2ee_locked";

/**
 * Returns whether Demo Mode E2EE is treated as unlocked on this device.
 * Enabled and unlocked by default in Demo Mode unless locked via Account Settings.
 */
export function isDemoE2eeDeviceUnlocked(): boolean {
  try {
    return sessionStorage.getItem(DEMO_E2EE_LOCKED_KEY) !== "1";
  } catch {
    return true;
  }
}

/**
 * Updates the Demo Mode E2EE lock/unlock state in browser session storage.
 */
export function setDemoE2eeDeviceLocked(locked: boolean): void {
  try {
    if (locked) {
      sessionStorage.setItem(DEMO_E2EE_LOCKED_KEY, "1");
    } else {
      sessionStorage.removeItem(DEMO_E2EE_LOCKED_KEY);
    }
  } catch {
    // Ignore storage access errors in restricted environments
  }
}
