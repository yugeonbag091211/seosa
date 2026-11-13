'use strict';
const crypto = require('crypto');
// Only call with a server-verified email. No profile is created without a secret.
function profileUserId(email) {
  const secret = process.env.AI_V3_PROFILE_SECRET || process.env.AUTH_SECRET || process.env.SUPABASE_SECRET_KEY;
  if (!secret || !email) return '';
  return crypto.createHmac('sha256', secret).update('seosa-v3-user:' + String(email).trim().toLowerCase()).digest('hex');
}
module.exports = { profileUserId };
