import type { RestrictedContentReason } from './discovery-contracts';

const ADVERSE_OR_JUDICIAL =
  /\b(imputad[oa]s?|formalizad[oa]s?|condenad[oa]s?|sentencia(?:s)?|procesad[oa]s?|mala\s+praxis|negligencia\s+m[eé]dica|denuncia(?:s|do|da)?|tribunal\s+de\s+[eé]tica)\b/iu;
const MINOR_OR_PRIVATE_HEALTH =
  /\b(menor(?:es)?\s+de\s+edad|niñ[oa]s?|adolescente(?:s)?|historia\s+cl[ií]nica|diagn[oó]stico\s+del\s+paciente)\b/iu;
const AUTOMATION_CHALLENGE =
  /\b(captcha|anomaly-modal|challenge-platform|verify\s+you\s+are\s+human)\b/iu;

export function classifySourceContent(text: string): RestrictedContentReason | undefined {
  if (AUTOMATION_CHALLENGE.test(text)) {
    return 'AUTOMATION_CHALLENGE';
  }
  if (ADVERSE_OR_JUDICIAL.test(text)) {
    return 'ADVERSE_OR_JUDICIAL';
  }
  if (MINOR_OR_PRIVATE_HEALTH.test(text)) {
    return 'MINOR_OR_PRIVATE_HEALTH';
  }
  return undefined;
}
