// Each resource has its own request, failure and retry state. A slow order
// service must never postpone a successful course-entitlement response.
export function createLearningResource({ load, onData, onError, timeoutMs = 12000 }) {
  let pending = null;
  let loaded = false;
  return function request() {
    if (loaded) return Promise.resolve();
    if (pending) return pending;
    let timer;
    pending = Promise.race([
      Promise.resolve().then(load),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Request timed out')), timeoutMs); }),
    ]).then(result => {
      if (result?.error) throw result.error;
      if (!Array.isArray(result?.data)) throw new Error('Invalid learning response');
      loaded = true;
      return onData(result.data);
    }).catch(error => {
      loaded = false;
      onError(error);
    }).finally(() => {
      clearTimeout(timer);
      pending = null;
    });
    return pending;
  };
}
