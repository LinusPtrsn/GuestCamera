export function normalizeBuildVersion(version: string | null | undefined) {
  return version?.trim() || 'dev';
}

export function getBuildStatus(frontendVersion: string | null, backendVersion: string | null) {
  const normalizedFrontend = normalizeBuildVersion(frontendVersion);
  const normalizedBackend = backendVersion?.trim() || null;
  const hasMismatch = normalizedBackend !== null && normalizedBackend !== normalizedFrontend;

  return {
    hasMismatch,
    label: hasMismatch ? `FE ${normalizedFrontend} / BE ${normalizedBackend}` : normalizedFrontend,
    title: hasMismatch
      ? `Frontend build ${normalizedFrontend} unterscheidet sich vom Backend build ${normalizedBackend}.`
      : `Build ${normalizedFrontend}`
  };
}
