/** A sample shop that was auto-paused should take orders again. A locked or real shop must not. */
function demoShouldReopen(pub, settings) {
  if (!settings?.demo) return false;
  if (pub?.locked) return false;
  return pub?.acceptOrders === false || settings.acceptOrders === false;
}

module.exports = { demoShouldReopen };
