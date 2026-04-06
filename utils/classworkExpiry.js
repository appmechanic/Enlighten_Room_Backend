function isPositiveSeconds(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function getQuestionExpirySeconds(question) {
  if (!question || typeof question !== 'object') {
    return null;
  }

  return isPositiveSeconds(question.expiryTime) ? question.expiryTime : null;
}

export function getQuestionAiExpirySeconds(question) {
  if (!question || typeof question !== 'object') {
    return null;
  }

  if (isPositiveSeconds(question.aiExpiryTime)) {
    return question.aiExpiryTime;
  }

  return getQuestionExpirySeconds(question);
}

export function getExpiryState(createdAt, durationSeconds) {
  if (!createdAt || !isPositiveSeconds(durationSeconds)) {
    return {
      isConfigured: false,
      isExpired: false,
      expiresAt: null,
      remainingMs: null,
    };
  }

  const createdAtTime = new Date(createdAt).getTime();
  if (!Number.isFinite(createdAtTime)) {
    return {
      isConfigured: false,
      isExpired: false,
      expiresAt: null,
      remainingMs: null,
    };
  }

  const expiresAtTime = createdAtTime + durationSeconds * 1000;
  const remainingMs = expiresAtTime - Date.now();

  return {
    isConfigured: true,
    isExpired: remainingMs <= 0,
    expiresAt: new Date(expiresAtTime).toISOString(),
    remainingMs: Math.max(remainingMs, 0),
  };
}

export function isValidExpirySeconds(value) {
  return isPositiveSeconds(value);
}
