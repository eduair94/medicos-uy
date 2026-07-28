# ADR 0002: credenciales separadas y publicación fail-closed

- Estado: aceptada
- Fecha: 2026-07-27

## Contexto

El pipeline interno contiene nombres y títulos habilitados del MSP, además de candidatos de cruce
con carteleras institucionales. La API inicial sólo modelaba el nombre y permitía una evidencia
cuando su estado era `APPROVED`. Ese control era insuficiente: no exigía aprobación de la fuente,
compatibilidad de finalidad, autorización de reutilización, confianza determinista ni vigencia.

Los títulos registrados tampoco deben confundirse con:

- la visibilidad editorial de un perfil;
- el servicio en el cual aparece una persona en una mutualista;
- una especialidad inferida;
- una afiliación institucional todavía no confirmada.

## Decisión

1. Los títulos registrados viven en el módulo hexagonal `credentials`, separado de
   `professionals`.
2. La proyección pública muestra únicamente títulos con estado `ENABLED`.
3. Cada título referencia evidencia propia y un `evidence_claim` debe enlazar exactamente la
   evidencia, el profesional, el tipo de campo y el valor normalizado. El nombre no funciona como
   evidencia implícita de todo el perfil.
4. `provenance.source` agrega tres compuertas independientes:
   - aprobación de publicación;
   - compatibilidad de finalidad;
   - fundamento de reutilización.
5. La evidencia agrega confianza, vencimiento e ID público independiente. Una evidencia
   `CANDIDATE`, pendiente, revocada o vencida no aparece en vistas públicas.
6. La aprobación de una fuente exige política, revisor, fecha, referencia y vencimiento. Las vistas
   retiran la fuente cuando esa decisión vence y rechazan combinaciones incompatibles de tipo de
   fuente, consentimiento y licencia.
7. La migración vuelve a `PENDING` cualquier evidencia y fuente previamente aprobada. Toda fuente y
   evidencia preexistente debe ser revisada nuevamente bajo el contrato más estricto.
8. Las vistas exponen UUID públicos separados para profesional, título y evidencia. El rol público
   mantiene acceso exclusivamente a vistas `security_barrier`; los IDs y tablas internas se
   revocan explícitamente.
9. La exportación NDJSON pública es un proceso distinto. Requiere una política externa aprobada,
   vigente y firmada con Ed25519 contra una clave anclada por huella. La policy autoriza el
   `snapshotId` y `profilesSha256` exactos, limita la antigüedad de fuente y el proceso verifica la
   cadena completa del snapshot factual-v3. Exige además aprobaciones separadas de aviso, registro
   de base, ejercicio de derechos, seguridad/retención y determinación de EIPD/DPO, junto con la
   configuración completa del artículo 13. Una allowlist fija genera identificadores públicos
   separados mediante HMAC; ni el secreto ni una huella derivada de él se publican.
10. Los candidatos de mutualistas, IDs internos, cédulas, números de Caja, puntajes de coincidencia,
    reseñas y datos adversos nunca forman parte de esa exportación.
11. Los snapshots internos y las exportaciones públicas se instalan como directorios completos con
    staging y un único renombre atómico.
12. El artefacto no se sirve estáticamente. La interfaz de entrega autentica el manifiesto mediante
    HMAC con una clave separada, verifica hash y vencimiento en cada apertura y rechaza contenido
    alterado o expirado aunque permanezca retenido para auditoría.

## Consecuencias

- Revocar una fuente, vencer su decisión o vencer una evidencia retira automáticamente sus hechos
  dependientes.
- Configurar un disclaimer o completar variables de entorno no aprueba una fuente.
- El endpoint de credenciales es
  `GET /v1/professionals/:professionalId/credentials`.
- Los valores de registro temporario se preservan como `NONE`, `WITH_CONTRACT` y
  `WITHOUT_CONTRACT`.
- Las agendas requerirán un módulo y una política propios; esta decisión no las publica.
- La política de ejemplo permanece deliberadamente desaprobada. No es una autorización para
  exportar datos reales.
