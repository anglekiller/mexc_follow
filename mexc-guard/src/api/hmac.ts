import CryptoJS from 'crypto-js';

import type { HmacFn } from '../exchanges/common';

/** HMAC-SHA256 hex via crypto-js (React Native has no WebCrypto). */
export const hmacSha256: HmacFn = async (secret, message) =>
  CryptoJS.HmacSHA256(message, secret).toString(CryptoJS.enc.Hex);
