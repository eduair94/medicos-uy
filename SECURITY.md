# Seguridad

## Versiones soportadas

Mientras el proyecto esté en `0.x`, solo la rama `main` recibe correcciones de seguridad.

## Reportar una vulnerabilidad

No abra un issue público si el reporte contiene una vulnerabilidad explotable, credenciales,
topología privada o datos personales. Use
[GitHub Private Vulnerability Reporting](https://github.com/eduair94/medicos-uy/security/advisories/new).

Incluya, cuando sea posible:

- componente y versión;
- impacto y prerrequisitos;
- reproducción mínima con datos sintéticos;
- comportamiento esperado;
- mitigación temporal conocida.

No envíe snapshots reales ni pruebe una vulnerabilidad contra fuentes, prestadores o servicios de
terceros sin autorización. El proyecto acusará recibo tan pronto como sea posible y coordinará
divulgación y corrección según severidad.

## Secretos y datos personales

Los archivos `.env*` locales, `data/`, material TLS, backups y el paquete operativo del servidor
real están excluidos de Git. Si un secreto se incorpora por error, debe revocarse y rotarse; borrar
el archivo de un commit posterior no es suficiente.
