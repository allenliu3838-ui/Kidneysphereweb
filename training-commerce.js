// Explicit catalog identities. Display prices still come from the server.
const SPECIALTIES = ['GLOM', 'ICU', 'TX', 'PATHO', 'DA'];
const KINDS = new Map();
for (const spec of SPECIALTIES) {
  KINDS.set(`${spec}-REG-FULL-2026`, ['registration', 'project_registration']);
  KINDS.set(`${spec}-BUNDLE-2026`, ['bundle', 'specialty_bundle']);
  KINDS.set(`${spec}-REG-VIDEO-2026`, ['retired_replay', 'project_registration']);
}

export function classifyTrainingProduct(product) {
  const entry = KINDS.get(product?.product_code);
  return entry && entry[1] === product?.product_type ? entry[0] : null;
}

export function isRetiredTrainingReplay(product) {
  return KINDS.get(product?.product_code)?.[0] === 'retired_replay';
}

// Resume the stored order amount, including orders created before a price change.
// Never substitute the current catalog price or trust a create-RPC price echo.
export function checkoutOrderSummary(order, userId) {
  if (!order?.id || order.user_id !== userId || !order.order_no) {
    throw new Error('无法核对订单，请从“我的学习”打开自己的订单。');
  }
  if (!['pending_payment', 'rejected'].includes(order.status)) {
    throw new Error('该订单已进入审核或已完成，请在“我的学习”查看状态。');
  }
  const items = order.order_items;
  const cents = value => {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    const result = Math.round(number * 100);
    return Number.isFinite(number) && number >= 0 && Number.isSafeInteger(result)
      && Math.abs(number * 100 - result) < 0.00001 ? result : null;
  };
  const total = cents(order.total_amount_cny);
  if (!Array.isArray(items) || !items.length || total === null) {
    throw new Error('订单金额不完整，请联系管理员核对。');
  }
  let sum = 0;
  for (const item of items) {
    const amount = cents(item.amount_cny);
    if (!item.product_id || !Number.isInteger(item.quantity) || item.quantity <= 0 || amount === null) {
      throw new Error('订单明细不完整，请联系管理员核对。');
    }
    sum += amount;
  }
  if (!Number.isSafeInteger(sum) || sum !== total) {
    throw new Error('订单总额与明细不一致，请联系管理员核对。');
  }
  return {
    id: items[0].product_id,
    title: items.map(item => item.product_title).filter(Boolean).join('、') || '订单商品',
    price_cny: total / 100,
    subtitle: '按本订单确认的金额支付。',
  };
}
