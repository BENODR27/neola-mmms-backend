const jwt = require("jsonwebtoken");

module.exports = async function authenticate(req, res, next) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match)
    return res
      .status(401)
      .json({ error: { message: "Bearer token required" } });

  const token = match[1];
  try {
    req.auth = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: process.env.JWT_ISSUER || "platform-iam",
      audience: process.env.JWT_AUDIENCE || "platform-applications",
    });
    await require('./subscription-access')(req);
    return next();
  } catch (error) {
    return res
      .status(error.status || 401)
      .json({ error: { message: error.status ? error.message : "Invalid or expired token" } });
  }
};
