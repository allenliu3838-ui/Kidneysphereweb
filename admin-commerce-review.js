/** Pure validation shared by the payment review screen and its tests. */
import { classifyTrainingProduct } from './training-commerce.js?v=20260914_pricing1';

const FULL_PROJECT_CODES = {
  'GLOM-REG-FULL-2026': 'PROJ-GLOM-2026',
  'ICU-REG-FULL-2026': 'PROJ-ICU-2026',
  'TX-REG-FULL-2026': 'PROJ-TX-2026',
  'PATHO-REG-FULL-2026': 'PROJ-PATHO-2026',
  'DA-REG-FULL-2026': 'PROJ-DA-2026',
};

export function productBindingPolicy(product) {
  const kind = classifyTrainingProduct(product);
  return {
    projectForbidden: kind === 'bundle' || kind === 'retired_replay',
    expectedProjectCode: kind === 'registration' ? FULL_PROJECT_CODES[product.product_code] : null,
    projectRequired: kind !== 'retired_replay' && ['project_registration', 'registration_plus_bundle'].includes(product.product_type),
  };
}
export function reviewApprovalState(order, fulfillment, checks = []) {
  if (!order || !['pending_review', 'pending_payment'].includes(order.status)) {
    return { allowed: false, reason: '订单当前状态不能审核通过' };
  }
  if (!fulfillment?.ok || fulfillment.order_id !== order.id ||
      fulfillment.mapping_status !== 'ready' || !fulfillment.review_fingerprint ||
      !Array.isArray(fulfillment.items) || !fulfillment.items.length) {
    return { allowed: false, reason: '项目归属或审核数据未通过服务端校验，请刷新详情' };
  }
  if (!Array.isArray(fulfillment.proof_checks) || !fulfillment.proof_checks.some(proof => proof.valid === true)) {
    return { allowed: false, reason: '缺少金额一致的有效支付凭证' };
  }
  if (checks.length !== 4 || !checks.every(checked => checked === true)) {
    return { allowed: false, reason: '请确认实际到账并完成全部审核清单' };
  }
  return { allowed: true, reason: '' };
}

export function validateProductBinding(row, projects, cohorts) {
  const policy = productBindingPolicy(row);
  if (policy.projectForbidden && (row.project_id || row.cohort_id)) return '整套课和原回放商品不含培训报名，不能关联项目或班期';
  if (policy.projectRequired && !row.project_id) return '项目报名商品必须选择真实项目';
  if (row.project_id && !projects.some(project => project.id === row.project_id)) return '所选项目不存在，请重新选择';
  if (policy.expectedProjectCode && !projects.some(project => project.id === row.project_id && project.project_code === policy.expectedProjectCode)) {
    return `本商品只能归属项目 ${policy.expectedProjectCode}`;
  }
  if (row.cohort_id && !cohorts.some(cohort => cohort.id === row.cohort_id && cohort.project_id === row.project_id)) {
    return '所选班期不属于当前项目，请重新选择';
  }
  return '';
}

export function canRepairEnrollment(order, fulfillment, issue) {
  if (order?.status !== 'approved' || issue?.order_id !== order.id || issue.can_repair !== true ||
      fulfillment?.ok !== true || fulfillment.order_id !== order.id ||
      !Array.isArray(fulfillment.items) || !Array.isArray(issue.items)) return false;
  const missing = issue.items.filter(item => item.repair_required === true);
  return missing.length > 0 && missing.every(item => fulfillment.items.some(current =>
    current.order_item_id === item.order_item_id && current.product_id === item.product_id &&
    current.project_id && current.project_id === item.project_id &&
    (current.cohort_id || null) === (item.cohort_id || null) && current.enrollment_required === true));
}
