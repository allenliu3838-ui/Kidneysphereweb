/**
 * Password strength validator.
 *
 * Requirements:
 *   - At least 8 characters
 *   - At least 1 uppercase letter
 *   - At least 1 lowercase letter
 *   - At least 1 digit
 *   - At least 1 special character
 *
 * Returns { valid: boolean, errors: string[] }
 */
export function validatePassword(password) {
  const errors = [];

  if (!password || password.length < 8) {
    errors.push("至少 8 位");
  }
  if (!/[A-Z]/.test(password)) {
    errors.push("至少 1 个大写字母");
  }
  if (!/[a-z]/.test(password)) {
    errors.push("至少 1 个小写字母");
  }
  if (!/[0-9]/.test(password)) {
    errors.push("至少 1 个数字");
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    errors.push("至少 1 个特殊字符（如 !@#$%）");
  }

  return {
    valid: errors.length === 0,
    errors,
    message: errors.length ? "密码要求：" + errors.join("、") : "",
  };
}
