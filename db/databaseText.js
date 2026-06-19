const UTF8_PREFIX = "__UTF8_BASE64__:";

function encodeDatabaseText(value) {
  if (value === null || value === undefined) return value;

  const text = String(value);
  if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(text)) return text;

  return `${UTF8_PREFIX}${Buffer.from(text, "utf8").toString("base64")}`;
}

function decodeDatabaseText(value) {
  if (typeof value !== "string" || !value.startsWith(UTF8_PREFIX)) return value;

  try {
    return Buffer.from(value.slice(UTF8_PREFIX.length), "base64").toString("utf8");
  } catch {
    return value;
  }
}

module.exports = {
  decodeDatabaseText,
  encodeDatabaseText,
};
