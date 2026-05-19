const QRCode = require("qrcode");

async function generateDataUrl(text) {
  return QRCode.toDataURL(text, {
    margin: 1,
    width: 320,
  });
}

module.exports = {
  generateDataUrl,
};
