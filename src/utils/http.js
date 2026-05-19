function createHttpError(statusCode, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details || null;
  return error;
}

function isProduction() {
  return process.env.NODE_ENV === "production";
}

module.exports = {
  createHttpError,
  isProduction,
};
