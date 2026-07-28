# Borrador de consulta a la URCDP

> Documento preparatorio. Debe completarlo y presentarlo el responsable jurídico de la futura
> plataforma. No contiene datos personales ni constituye una consulta ya enviada.

## Descripción del proyecto

Se proyecta un directorio uruguayo de profesionales médicos con finalidad informativa para
pacientes. La primera fase utilizaría exclusivamente:

- nombre;
- títulos y especialidades registrados;
- estado y registro temporario informados por el MSP;
- fuente, fecha de corte y enlace a la consulta oficial.

Las carteleras de prestadores se mantendrían en un entorno interno hasta obtener autorización y
revisión humana. No se prevé publicar imputaciones, sentencias, sanciones, fallos éticos, historias
clínicas ni inferencias de mala praxis.

El sistema separa catálogo público, procedencia, candidatos de vinculación e identidad. Todo dato
público necesita evidencia vigente y una fuente con aprobación documentada de finalidad y
reutilización.

## Preguntas

1. ¿La base [Infotítulos del MSP](https://www.gub.uy/ministerio-salud-publica/datos-y-estadisticas/microdatos/infotitulos-base-datos)
   puede ser reutilizada en un directorio privado, incluso comercial, para publicar nombre, títulos,
   estado y registro temporario, con atribución y actualización periódica? ¿Qué licencia o
   autorización debe documentarse?
2. ¿Las agendas públicas de prestadores, destinadas a que pacientes conozcan profesionales,
   especialidades, sedes y horarios, califican como fuente pública del artículo 9-BIS para su
   agregación por un tercero? ¿Se requiere consentimiento del profesional o autorización del
   prestador?
3. ¿Es admisible publicar reseñas estructuradas sobre puntualidad, trato, claridad y coordinación
   cuando el profesional no haya consentido? En caso afirmativo, ¿qué fundamento, información,
   moderación, derecho de respuesta y umbral de agregación exige la Unidad?
4. ¿El último inciso del artículo 18 de la Ley 18.331 impide que una empresa privada indexe
   nominalmente sentencias firmes o fallos éticos publicados por una autoridad? El proyecto los
   mantendrá excluidos hasta recibir una respuesta expresa.
5. Para Firebase Authentication, ¿qué mecanismo de transferencia internacional corresponde
   actualmente cuando la entidad importadora o sus subencargados tratan datos en Estados Unidos?
   ¿Se requiere autorización previa además de cláusulas modelo?
6. ¿El directorio factual, sus cruces internos y una futura función de reseñas requieren EIPD desde
   la primera fase? ¿Debe designarse delegado antes de superar 35.000 titulares?

## Anexos sugeridos

- Diagrama de separación de datos.
- Modelo público exacto y allowlist.
- Política de vencimiento y revocación.
- Flujo de acceso, rectificación, actualización y supresión en cinco días hábiles.
- Modelo de consentimiento y moderación, si se consulta sobre reseñas.
- Contrato y mapa de transferencias de Firebase/Google.

Trámite oficial:
[Consultas a la URCDP](https://www.gub.uy/tramites/consultas-unidad-reguladora-control-datos-personales-urcdp).
