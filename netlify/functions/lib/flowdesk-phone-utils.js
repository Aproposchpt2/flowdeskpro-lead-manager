'use strict';

const crypto = require('crypto');

function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length > 7) return `+${digits}`;
  return null;
}

function getPhoneLast4(phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  const digits = normalized.replace(/\D/g, '');
  return digits.slice(-4);
}

function hashPhone(phone) {
  const salt = process.env.PHONE_HASH_SALT;
  if (!salt) throw new Error('PHONE_HASH_SALT environment variable is not set');

  const normalized = normalizePhone(phone);
  if (!normalized) throw new Error('Invalid phone number');

  return crypto
    .createHash('sha256')
    .update(salt + normalized)
    .digest('hex');
}

module.exports = { normalizePhone, getPhoneLast4, hashPhone };
