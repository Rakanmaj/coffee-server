const crypto = require("crypto");

const TOKEN_TTL_SECONDS = 12 * 60 * 60;
const authSecret =
  process.env.AUTH_SECRET || crypto.randomBytes(48).toString("base64url");

if (!process.env.AUTH_SECRET) {
  console.warn(
    "AUTH_SECRET is not set. Login tokens will be invalidated whenever the server restarts."
  );
}

function signAuthToken(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: Number(user.user_id),
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

function verifyAuthToken(token) {
  if (typeof token !== "string") return null;

  const [encodedPayload, suppliedSignature, extra] = token.split(".");
  if (!encodedPayload || !suppliedSignature || extra) return null;

  const suppliedBuffer = Buffer.from(suppliedSignature);
  const expectedBuffer = Buffer.from(sign(encodedPayload));
  if (
    suppliedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(payload.sub) || payload.sub <= 0) return null;
    if (!Number.isInteger(payload.exp) || payload.exp <= now) return null;
    return payload;
  } catch {
    return null;
  }
}

function sign(value) {
  return crypto.createHmac("sha256", authSecret).update(value).digest("base64url");
}

module.exports = { signAuthToken, verifyAuthToken };
