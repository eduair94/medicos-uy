# ADR 0003: API de investigación autenticada para el propietario

- Estado: aceptada
- Fecha: 2026-07-29

## Contexto

El análisis privado conserva candidatos obtenidos por coincidencia nominal con carteleras
institucionales, páginas académicas, noticias y fuentes disciplinarias. Esos candidatos contienen
información útil para investigación, pero no confirman por sí mismos identidad, afiliación,
especialidad, empleo, disponibilidad de agenda ni antecedentes.

La API de consulta estaba publicada detrás de Cloudflare Tunnel, pero no exigía credenciales. Que
un hostname no esté anunciado o indexado no lo vuelve privado: una solicitud anónima podía obtener
los perfiles MSP. El contrato de los dossiers, en cambio, autoriza únicamente
`AUTHENTICATED_PRIVATE_API` para una audiencia `OWNER_ONLY`.

## Decisión

1. Toda ruta HTTP, incluida la documentación Scalar, OpenAPI, catálogo y RSD, exige autenticación
   del propietario. Sólo `/health/live`, `/health/ready` y las solicitudes CORS `OPTIONS` quedan
   sin autenticación; no devuelven datos del directorio.
2. La autenticación acepta:
   - un Firebase ID token verificado con revocación y una allowlist explícita de UID;
   - `X-API-Key` para integraciones del propietario;
   - HTTP Basic para poder abrir Scalar en un navegador, usando la misma clave del propietario.
3. La clave nunca se guarda en el repositorio ni en el archivo de entorno en texto claro. El
   proceso conserva sólo SHA-256 y compara el valor presentado en tiempo constante. El secreto
   recuperable reside en un archivo externo `root:root 0600`.
4. En producción debe existir al menos un método de autenticación configurado. La aplicación
   aborta al iniciar si Firebase está incompleto o no existe una clave alternativa.
5. Se incorpora `GET /v1/professionals/:idOrSlug/research`. El endpoint devuelve el último dossier
   persistido y conserva expresamente:
   - método e índice de flexibilidad de cada coincidencia;
   - decisiones `identityConfirmed`, `factConfirmed`, `NOT_LINKED` y `NOT_PUBLISHED`;
   - alertas, URL canónica, fecha de observación y limitaciones de cada fuente;
   - horarios como cartelera observada, no como disponibilidad de turnos;
   - especialidades como etiquetas declaradas por la institución, no como títulos MSP.
6. Exponer un candidato dentro del dossier privado no cambia su decisión editorial ni lo convierte
   en un hecho confirmado. Los controles fail-closed de la exportación pública de ADR 0002 siguen
   vigentes.
7. La respuesta elimina IDs HMAC, rutas locales, hashes de artefactos y otros detalles operativos
   innecesarios para el cliente.
8. PostgreSQL ofrece una vista `security_barrier` específica para el propietario. El rol de la API
   sólo recibe `USAGE` del esquema y `SELECT` sobre esa vista; no recibe acceso directo a tablas de
   ingesta, candidatos o dossiers.
9. El proceso usa un pool separado, en modo de transacción de sólo lectura, y readiness comprueba
   que la vista y sus permisos estén disponibles antes de activar una versión.
10. Las respuestas autenticadas y los errores `401` usan `Cache-Control: private, no-store`. Los
    logs redactan `Authorization` y `X-API-Key`.

## Consecuencias

- Los clientes existentes deben enviar credenciales; una llamada anónima recibe `401`.
- Scalar puede abrirse con HTTP Basic y reutiliza esas credenciales para cargar OpenAPI.
- El frontend puede mostrar asociaciones y vínculos, pero debe conservar los estados y avisos que
  entrega la API.
- No se inventa un porcentaje de confianza: el índice 0/1/2 mide flexibilidad del nombre, no
  probabilidad de identidad.
- Para habilitar Firebase en un host fuera de Google Cloud deben instalarse credenciales de
  aplicación y configurarse proyecto y UID del propietario.
- Una futura API pública requerirá otra superficie, otros roles y una decisión de publicación
  independiente; no se obtiene quitando la autenticación de esta API.
