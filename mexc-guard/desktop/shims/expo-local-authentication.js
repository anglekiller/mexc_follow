// No fingerprint unlock on the desktop: Settings reports the lock as unavailable.
export const SecurityLevel = { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 };
export const hasHardwareAsync = async () => false;
export const getEnrolledLevelAsync = async () => SecurityLevel.NONE;
export const authenticateAsync = async () => ({ success: false, error: 'not_available' });
