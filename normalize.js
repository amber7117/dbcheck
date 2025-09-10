const { parsePhoneNumberFromString } = require('libphonenumber-js');
const { defaultRegion } = require('./config');

function toE164(input, region = defaultRegion) {
  const s = (input || '').toString().trim();
  if (!s) return null;
  // 已经带+则直接解析
  const pn = s.startsWith('+')
    ? parsePhoneNumberFromString(s)
    : parsePhoneNumberFromString(s, region);
  return pn && pn.isValid() ? pn.number : null;
}

module.exports = { toE164 };
