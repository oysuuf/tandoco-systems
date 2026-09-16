// ═════════════════════════════════════════════════════════════════════
// "May this customer SPEND their TandoCoins?" — the one helper that answers
// it, so no surface re-derives the rule inline and drifts.
//
// THE RULE: coins are display-only until the customer has actually PAID us
// for something. TWO different purchases prove that, and either is enough:
//
//   · firstOrderCompleted — a paid order on the WEBSITE. Set once by the
//     Stripe webhook on the first successful payment_intent.
//   · coinsUnlocked       — a paid purchase at a MARKET BOOTH. Set by
//     marketWallet.js marketEarn (phone matched a real account) or by
//     claimWalletForCustomer (a booth wallet swept into an account).
//
// WHY BOTH: a booth sale is written as a marketTicket, not an order, so it
// never touches firstOrderCompleted. Gating on that flag alone told booth
// regulars the coins they'd earned with cash at the booth were locked until
// they ordered online — while the till standing next to them happily let
// them spend those same coins. Two surfaces, same customer, opposite answers.
//
// WHY NOT JUST FLIP firstOrderCompleted ON A BOOTH SALE: that flag is
// overloaded. It ALSO means "hasn't used the website newcomer perks" — it
// gates the first-order discount (calculateQuote `isFirstOrder`) and the
// referral free meal. Flipping it at the booth would silently spend a booth
// customer's newcomer discount before they ever visited the site, which is
// backwards: that discount is the carrot that gets them ordering online.
// So the two meanings stay separate. (Omar's call, Jul 29 2026.)
//
// THE ABUSE GUARD THIS PRESERVES: the free signup bonus must NOT be
// spendable until real money has changed hands, or the program can be farmed
// by making accounts. Neither flag is ever set by signing up, so it holds.
// Note the STRICT `=== true` below: a legacy customer doc that simply lacks
// the coinsUnlocked field is not evidence of a purchase.
// ═════════════════════════════════════════════════════════════════════
'use strict';

// Can this customer spend coins? Accepts a raw customers/{uid} doc, or any
// object carrying the same two field names (both readers pass one or the
// other, so the field names ARE the contract — don't rename them here
// without renaming them on the documents).
function coinsRedeemable(cust) {
  if (!cust) return false;
  return !!cust.firstOrderCompleted || cust.coinsUnlocked === true;
}

// What coinsUnlocked should be after a write that wants to (re)stamp it.
// ONCE TRUE, IT STAYS TRUE. Several paths re-stamp this field on customer
// docs that already exist (the signup-bonus trigger, bootstrapCustomerDoc),
// and they used to copy it straight from firstOrderCompleted. For a booth
// regular that was a DOWNGRADE: signing up, or merely signing in, re-locked
// coins they had already bought with cash at a booth. Never downgrade.
function nextCoinsUnlocked(cust) {
  if (!cust) return false;
  return cust.coinsUnlocked === true || !!cust.firstOrderCompleted;
}

module.exports = { coinsRedeemable, nextCoinsUnlocked };
