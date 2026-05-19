const purchaseStatuses = ["paid", "pending", "failed", "refunded", "expired"];
const purchaseModes = ["new", "renew"];

const allowedStatusTransitions = {
  pending: ["pending", "paid", "failed", "expired"],
  paid: ["paid", "refunded", "expired"],
  failed: ["failed", "pending"],
  refunded: ["refunded"],
  expired: ["expired"],
};

function canTransitionPurchaseStatus(fromStatus, toStatus) {
  const allowed = allowedStatusTransitions[fromStatus] || [];
  return allowed.includes(toStatus);
}

module.exports = {
  purchaseStatuses,
  purchaseModes,
  allowedStatusTransitions,
  canTransitionPurchaseStatus,
};
