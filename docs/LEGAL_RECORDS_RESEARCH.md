# Investigación de actuaciones judiciales

> Política técnica para investigación y descubrimiento. No habilita una base nominal, una
> publicación ni una vinculación con perfiles médicos.

## Decisión

Los datos relativos a infracciones penales, civiles o administrativas no forman parte del
directorio factual. El
[artículo 18 de la Ley 18.331](https://www.impo.com.uy/bases/leyes/18331-2008/18)
reserva su tratamiento a autoridades públicas competentes, salvo autorización legal específica.
Una noticia, una página visible o un disclaimer no trasladan esa competencia a un directorio
privado.

Hasta obtener un criterio jurídico escrito y, prudentemente, una consulta favorable de la URCDP:

- no se almacena una persona imputada, denunciada o condenada en la base del producto;
- no existe clave foránea entre perfiles médicos y expedientes;
- no se indexan nombres, IUE, delitos ni estados procesales en la búsqueda pública;
- no se genera puntaje de riesgo, etiqueta de mala praxis ni captación comercial basada en una
  actuación judicial;
- toda noticia es una pista externa de investigación, no una afirmación del sistema.

## Fuentes oficiales disponibles

### Agenda de audiencias

La
[Consulta de Audiencias del Poder Judicial](https://consultaaudiencias.poderjudicial.gub.uy/)
permite filtrar por materia, sede y fecha. Puede mostrar hora, fecha, IUE y carátula. Las causas
pueden figurar como `RESERVADO`; el resultado no tiene un enlace permanente y no necesariamente
identifica personas.

Sirve para corroborar que una audiencia estuvo o está agendada. No aporta por sí sola:

- la solicitud fiscal;
- la resolución o acta de formalización;
- la identidad de las personas cuando la carátula está reservada;
- el delito finalmente admitido;
- el resultado posterior del proceso.

### Consulta de expedientes

El
[Poder Judicial](https://www.poderjudicial.gub.uy/node/999999729)
indica expresamente que la consulta pública en línea por IUE excluye las causas penales. El acceso
a una actuación reservada debe solicitarse a la sede y puede ser denegado o limitado.

### Base de Jurisprudencia Nacional

La [BJN Pública](https://bjn.poderjudicial.gub.uy/BJNPUBLICA/busquedaSelectiva.seam)
publica jurisprudencia, principalmente de tribunales de apelaciones y de la Suprema Corte. Es una
fuente adecuada para sentencias publicadas, pero no un repositorio exhaustivo de solicitudes y
resoluciones de formalización de primera instancia.

El [manual oficial](https://bjn.poderjudicial.gub.uy/BJNPUBLICA/manual_BJNPUBLICA.pdf)
documenta frases exactas, operadores `AND`, `OR`, `NOT`, comodines y filtros. El buscador procesa
todo el texto y metadatos, por lo que una consulta con nombre y apellido puede devolver un fallo
en el cual las palabras aparecen en personas distintas. Todo resultado requiere leer la sentencia
completa.

### Datos abiertos del nuevo CPP

El
[recurso mensual del Poder Judicial](https://catalogodatos.gub.uy/dataset/suprema-corte-de-justicia-informacion-del-nuevo-codigo-de-proceso-penal/resource/15947c9c-58ef-4ebb-a111-fb2c7e91015f)
es apto para análisis estadístico, no para identificar profesionales. El archivo descargado el
27/07/2026 cubre hasta el 30/06/2026 y contiene:

- 166.992 filas;
- 164.687 identificadores internos distintos;
- 21.337 filas con estado `Formalización`;
- únicamente `Expediente`, `Fecha Inicio`, `Estado Expediente` y `Departamento`.

No contiene nombre, documento, profesión, delito, sede ni un IUE público reproducible. Intentar
reidentificar filas mediante fechas, departamento y noticias contradiría la finalidad protectora
de esa apertura.

La
[base semestral de Fiscalía](https://catalogodatos.gub.uy/es/dataset/fiscalia-general-de-la-nacion-imputaciones-y-condenas-a-personas)
incluye más variables procesales y delitos, pero anonimiza tanto el documento como el identificador
de noticia criminal. Su
[nota metodológica](https://catalogodatos.gub.uy/dataset/20cfecaa-f557-423b-b6fe-c137c85ecd1b/resource/f63d2e76-b55a-4a58-b5d2-2172affef5ad/download/nota-metodologica.pdf)
advierte además que el estado es una fotografía dinámica y puede cambiar por nuevas audiencias,
rezagos y controles de calidad.

## Estados que no deben mezclarse

```text
PISTA PERIODÍSTICA
  -> DENUNCIA / NOTICIA CRIMINAL
  -> SOLICITUD DE FORMALIZACIÓN
  -> FORMALIZACIÓN ADMITIDA
  -> ACUSACIÓN
  -> ARCHIVO | SOBRESEIMIENTO | ABSOLUCIÓN
     | CONDENA NO FIRME
       -> CONDENA EJECUTORIADA | REVOCADA
```

`PROCESAMIENTO` pertenece al régimen procesal histórico y no debe transformarse automáticamente
en condena. El
[artículo 266 del CPP](https://www.impo.com.uy/bases/codigo-proceso-penal-2017/19293-2014/266)
distingue la solicitud fiscal de su admisión por el juez. El
[artículo 217](https://www.impo.com.uy/bases/codigo-proceso-penal-2017/19293-2014/217)
exige tratar a la persona como inocente hasta una sentencia condenatoria ejecutoriada.

## Regla de correlación

Una similitud de nombre puede crear una tarea de búsqueda interna no nominal. Nunca produce una
atribución.

Para verificar identidad se exigirían, como mínimo:

1. documento o identificador oficial compartido por dos fuentes autorizadas; o
2. resolución oficial que individualice a la persona y un registro profesional oficial con el
   mismo identificador; y
3. revisión jurídica y de privacidad independiente; y
4. verificación del estado procesal, recursos, firmeza, fecha de corte y posibles rectificaciones.

Nombre, especialidad, empleador, LinkedIn, artículos académicos y fotografía son señales
corroborativas, no identificadores suficientes para unir una actuación adversa.

## Ruta correcta para obtener una resolución

1. Obtener el IUE de la agenda oficial, de una parte o de su abogado.
2. Solicitar a la sede la actuación concreta, indicando número y fecha.
3. Registrar si el acceso fue concedido, parcial, disociado o denegado.
4. Verificar firma, sede, fecha, objeto, personas individualizadas y parte dispositiva.
5. Calcular hash del documento original y conservar su cadena de procedencia sólo en un entorno
   autorizado.
6. Repetir la comprobación antes de cualquier uso, porque las medidas y el estado cambian.
7. Mantener la salida pública bloqueada aunque el documento sea auténtico, hasta resolver la base
   legal del tratamiento nominal.

## Siguiente decisión jurídica

Antes de implementar un repositorio nominal se debe presentar una
[consulta a la URCDP](https://www.gub.uy/tramites/consultas-unidad-reguladora-control-datos-personales-urcdp)
que describa fuentes, finalidad comercial, conservación, búsquedas, APIs, perfilado, destinatarios
y visualización. También corresponde una evaluación de impacto previa; esa evaluación identifica
riesgos, pero no crea una autorización que la ley no otorgue.
