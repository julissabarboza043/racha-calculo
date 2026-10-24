// Reglas del juego tal como las aplica la base de datos (función rule() en supabase/schema.sql).
// Si cambia un valor allá, cámbielo también aquí para que la app lo muestre bien.
export const RULES = {
  bonoPorDia: 0.05,
  diasTope: 10,
  castigoFallo: 0.15,
  minimo: 0.40,
  diasPerdidosRecuperar: 2,
  comodinesPorMes: 1,
};

export const multiplier = (streak) => 1 + RULES.bonoPorDia * Math.min(streak, RULES.diasTope);
export const attemptFactor = (fails) => Math.max(1 - RULES.castigoFallo * fails, RULES.minimo);

/** Multiplicador que se aplica a un ejercicio según cuándo se resuelve. */
export function timingMultiplier(timing, streakMult) {
  if (timing === 'a_tiempo' || timing === 'opcional') return streakMult;
  if (timing === 'recuperar') return 1 + (streakMult - 1) / 2;
  return 1;
}
