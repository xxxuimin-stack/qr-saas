/** Whether an admin may apply a payment claim. A second click must not extend the plan again. */
function paymentDecision(status) {
  if (status === "pending") return "apply";
  if (status === "confirmed" || status === "comp") return "already";
  return "blocked";
}

module.exports = { paymentDecision };
