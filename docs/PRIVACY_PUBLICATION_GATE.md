# Aviso de privacidad y compuerta de publicación

> Borrador técnico, no dictamen jurídico. El texto de un aviso no vuelve lícito un tratamiento que
> carece de fundamento, finalidad compatible, autorización de fuente o controles operativos.

## Alcance del primer directorio

El snapshot factual se limita a:

- nombre y títulos habilitados publicados por el MSP en Infotítulos;
- fecha de corte y enlace a la consulta oficial vigente;
- candidatos internos de vinculación con carteleras institucionales;
- procedencia, hashes y decisiones de revisión.

No incluye reseñas, noticias, procesos, sentencias, sanciones, inferencias de mala praxis, rankings
ni datos de pacientes. Ningún candidato institucional se publica sin autorización de la fuente y
revisión humana.

## Fundamento del bloqueo

La [Ley 18.331, artículo 7](https://www.impo.com.uy/bases/leyes/18331-2008/7) exige
datos veraces, adecuados, no excesivos, exactos y actualizados. El responsable debe corregir o
suprimir lo inexacto, falso o caduco; una cláusula de “no garantizamos exactitud” no sustituye esa
obligación.

El [artículo 9-BIS](https://www.impo.com.uy/bases/leyes/18331-2008/9_BIS) define de
forma limitada las fuentes públicas. El
[Dictamen 10/020 de la URCDP](https://www.gub.uy/unidad-reguladora-control-datos-personales/institucional/normativa/dictamen-n-10020)
aclara que Internet no es, por sí solo, una fuente pública. Por eso:

- Infotítulos se clasifica provisionalmente como fuente oficial; la licencia general de datos
  abiertos es sólo una referencia candidata hasta confirmar por escrito que aplica a ese dataset;
- una agenda mutual visible sin login sigue necesitando análisis de finalidad, consentimiento de
  inclusión, condiciones de reutilización y, prudentemente, acuerdo con la institución;
- LinkedIn, redes y páginas personales no se incorporan automáticamente;
- una noticia puede servir para descubrir una fuente primaria, no para crear una etiqueta nominal.

El [artículo 13](https://www.impo.com.uy/bases/leyes/18331-2008/13) exige informar de
forma expresa, precisa e inequívoca: finalidad y destinatarios; existencia, nombre, responsable y
domicilio de la base; si las respuestas son obligatorias o facultativas; consecuencias de
proporcionar datos, negarse o aportar datos inexactos; derechos; transferencias internacionales; y,
si existen valoraciones automatizadas, sus criterios, procesos y tecnología. El snapshot no usa
cuestionario ni valoración automatizada, pero lo declara explícitamente en vez de omitir esos
literales. Encargados y destinatarios son conceptos distintos y se configuran por separado. Los
[artículos 14](https://www.impo.com.uy/bases/leyes/18331-2008/14) y
[15](https://www.impo.com.uy/bases/leyes/18331-2008/15) fijan cinco días hábiles para
acceso y para resolver rectificación, actualización, inclusión o supresión. Mientras se verifica
un dato cuestionado, debe indicarse que está en revisión; la corrección es gratuita y debe
notificarse a los destinatarios dentro del quinto día hábil.

## Compuerta obligatoria

`data:build:directory` siempre produce `publicExportAllowed = false`. Antes de crear una exportación
pública separada deben estar documentados:

1. responsable, domicilio, contacto y política de privacidad;
2. inscripción de las bases ante la URCDP y datos visibles de inscripción;
3. base jurídica documentada de cada fuente y campo;
4. compatibilidad documentada entre la finalidad original y la del directorio;
5. autorización, licencia o análisis escrito de reutilización de cada fuente;
6. proceso autenticado de acceso, rectificación, actualización, inclusión y supresión;
7. plazo máximo de cinco días hábiles y propagación a cachés, índices, copias y destinatarios;
8. retención, actualización, caducidad, seguridad, incidentes y encargados;
9. transferencias internacionales y subencargados, incluido el uso de Firebase;
10. determinación documentada sobre EIPD y delegado de protección de datos;
11. aprobación jurídica y de privacidad de la versión exacta del aviso.

El JSON expresa cada aprobación como `{ "required": true, "approved": false }`. Completar variables
de entorno nunca cambia esos valores. Para cada fuente, las compuertas de base jurídica,
compatibilidad de finalidad y reutilización permanecen desaprobadas hasta que un proceso de
publicación separado consuma evidencia jurídica revisada. `publicExportAllowed` continúa en
`false`.

La exportación separada `data:build:public-directory` exige además una política vigente firmada con
Ed25519. El proceso verifica la firma separada contra una clave pública cuya huella DER/SPKI está
anclada fuera de la policy. La autorización se liga al `snapshotId` y al hash de perfiles exactos,
incluye una antigüedad máxima de fuente y no confía en el `mtime` para elegir datos. La policy
también exige decisiones firmadas e independientes sobre aviso del responsable, inscripción de la
base, circuito de derechos, seguridad/retención y determinación de EIPD/DPO. El aviso del snapshot
debe tener completa la configuración del artículo 13; ningún placeholder pendiente es aceptado.

También exige una clave distinta para generar identificadores públicos y una lista cerrada de
campos. Rechaza fuentes no aprobadas, reutilización pendiente, evidencia candidata, decisiones
vencidas, una cadena de artefactos alterada y cualquier campo fuera de la lista permitida. La vista
pública de PostgreSQL replica esas compuertas para que un error de aplicación tampoco exponga
registros no publicables. Los UUID públicos son distintos e inmutables respecto de las claves
internas y cada nombre o título requiere un claim que vincule persona, campo, valor normalizado y
evidencia. El artefacto estático declara como vigencia efectiva el menor vencimiento entre la
política y la autorización de fuente. No se expone como archivo estático: la única interfaz de
lectura soportada vuelve a verificar ruta, hash, conteo, salvaguardas y vencimiento al abrirlo, y
autentica el manifiesto con un HMAC y una clave operativa separada. Tanto esa clave como el secreto
de IDs deben ser valores aleatorios distintos de al menos 32 bytes, codificados como base64 canónico
o base64url canónico; el proceso rechaza su reutilización. Falla sin entregar perfiles cuando
alcanza esa fecha o si el manifiesto fue sustituido. La retención interna para auditoría no equivale
a disponibilidad pública.

Para MSP, `classification` es
`provisional_official_source_pending_dataset_specific_review` y la licencia mantiene
`appliesToDatasetConfirmed = false`. Para carteleras, la unidad de evaluación es cada combinación
de fuente, URL y campo: una aprobación institucional global no cubre automáticamente todos sus
directorios.

La [URCDP indica que deben inscribirse](https://www.gub.uy/unidad-reguladora-control-datos-personales/sobre-inscripcion-de-base-de-datos)
las bases con personas identificadas o identificables. Su
[guía de obligaciones](https://www.gub.uy/unidad-reguladora-control-datos-personales/politicas-y-gestion/obligaciones)
también exige seguridad, ejercicio de derechos y delegado cuando corresponda.

## Aviso corto por perfil

Cada registro generado referencia `uy-medical-directory-factual-v3`, la fecha ISO de corte y la
frecuencia prevista `monthly`. Por ejemplo:

> Información de habilitación y títulos según Infotítulos del MSP, corte 2026-06-30. Actualización
> prevista: mensual. Consulte la vigencia actual en la fuente oficial.

El aviso corto acompaña, pero no reemplaza, la política completa.

## Plantilla completa

No se debe renderizar mientras existan campos sin configurar. Los marcadores de esta plantilla son
exclusivamente explicativos: el generador rechaza corchetes, dominios de ejemplo y otros
placeholders, correos inválidos y URLs que no sean HTTPS absolutas.

> Este directorio es operado por **[razón social]**, con domicilio en **[domicilio]**, responsable
> de la base inscripta ante la URCDP bajo **[número y fecha]**.
>
> Su finalidad es informar sobre habilitación profesional, títulos y, sólo cuando exista fundamento
> documentado, instituciones y horarios declarados. No brinda asesoramiento médico, no recomienda
> profesionales y no representa al MSP ni a los prestadores citados.
>
> La habilitación de este perfil procede de **Infotítulos del MSP [URL, versión y fecha de corte]**.
> Los lugares y horarios, si se publican, proceden de **[institución, URL y fecha de observación]**.
> Confirme cambios directamente con la fuente.
>
> La persona titular puede solicitar gratuitamente acceso, rectificación, actualización, inclusión
> o supresión en **[correo/formulario y domicilio]**. Se responderá dentro de cinco días hábiles,
> previa verificación proporcional de identidad. Mientras se verifica un dato, figurará como
> “en revisión”.
>
> Los datos son tratados por **[encargados]**, que actúan bajo instrucciones del responsable.
> Pueden comunicarse a **[destinatarios o clases de destinatarios]**. **[Existen/no existen]**
> transferencias internacionales a **[países]** bajo **[mecanismo]**. No se utiliza cuestionario ni
> valoración automatizada para construir este snapshot. Política completa: **[URL]**. Contacto del
> responsable o delegado: **[contacto]**.

## Estados del cruce

- `ABSTAINED`: valor por defecto; no se afirma que la identidad institucional sea el médico MSP.
- `LINKED`: futuro estado posible sólo mediante decisión humana válida y fuente autorizada.
- `REJECTED`: revisión que descarta la identidad.
- `under_review`: dato publicado previamente que fue impugnado y se encuentra verificándose.
- `withdrawn`: evidencia o autorización revocada; deja de alimentar la proyección pública.

La salida actual genera una resolución `ABSTAINED` por cada identidad de prestador. Los casos con
nombre y título coincidentes forman una cola de revisión, no una afiliación publicada.

## Contenido excluido

El [artículo 18](https://www.impo.com.uy/bases/leyes/18331-2008/18) vuelve especialmente
riesgoso para un privado tratar datos relativos a infracciones penales, civiles o administrativas.
Sentencias, fallos disciplinarios y etiquetas de “mala praxis” permanecen fuera del directorio
factual y requieren análisis jurídico independiente. Un disclaimer, una EIPD o que el documento
sea visible en Internet no subsanan una prohibición o falta de habilitación.
