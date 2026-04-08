'use strict';

// ── services/stripe.js ────────────────────────────────────────────────────────

const stripeLib = require('stripe')(process.env.STRIPE_SECRET_KEY);

const PRICE_IDS = {
  monthly:    process.env.STRIPE_PRICE_MONTHLY,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};

async function createCheckoutSession({ user, tier }) {
  const priceId = PRICE_IDS[tier];
  if (!priceId) throw Object.assign(new Error(`No Stripe price configured for tier: ${tier}`), { status: 400 });

  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripeLib.customers.create({ email: user.email, name: user.full_name, metadata: { user_id: user.id } });
    customerId = customer.id;
    const db = require('../db/queries');
    await db.updateUser(user.id, { stripe_customer_id: customerId });
  }

  const session = await stripeLib.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/dashboard?checkout=success`,
    cancel_url: `${process.env.APP_URL}/pricing?checkout=cancelled`,
    metadata: { user_id: user.id, tier },
    subscription_data: { metadata: { user_id: user.id, tier } },
  });

  return session;
}

async function createBillingPortal(stripe_customer_id) {
  return stripeLib.billingPortal.sessions.create({
    customer: stripe_customer_id,
    return_url: `${process.env.APP_URL}/dashboard`,
  });
}

function constructWebhookEvent(payload, signature, secret) {
  return stripeLib.webhooks.constructEvent(payload, signature, secret);
}

async function cancelSubscription(stripe_subscription_id) {
  return stripeLib.subscriptions.cancel(stripe_subscription_id);
}

module.exports = { createCheckoutSession, createBillingPortal, constructWebhookEvent, cancelSubscription };
