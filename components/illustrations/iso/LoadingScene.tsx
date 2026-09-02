'use client';

/**
 * LoadingScene — the settlement stack assembling on a loop, for SplashLoading.
 * Reduced motion renders the stack static. Motion lives in
 * SuiSettlementStack; this file only composes.
 *
 * Export sizes: 320, 640, 1280 — the scene is the focal object at every size.
 */
import type { IsoModuleProps } from './primitives';
import { SuiSettlementStack } from './SuiSettlementStack';

export interface LoadingSceneProps extends IsoModuleProps {
  labels?: readonly [string, string, string];
  crop?: 'focal' | 'full';
}

export function LoadingScene({ className, size = 160, label, ariaLabel, decorative = true, labels }: LoadingSceneProps) {
  return (
    <SuiSettlementStack className={className} size={size} label={label} ariaLabel={ariaLabel ?? label ?? 'Loading'} decorative={decorative} labels={labels} assembling loop />
  );
}

export default LoadingScene;
