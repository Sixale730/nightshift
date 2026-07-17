# nightshift

**Motor de guardrails para agentes de código con IA.** Auto-aprueba lo que es
demostrablemente inofensivo, bloquea en seco lo peligroso, y pregunta a un
humano por todo lo demás — para que un agente trabaje sin supervisión (de
noche, en CI, en tareas largas) sin que tengas que apagar su sistema de
seguridad.

*Read in English: [README.md](README.md)*

## El problema

Toda herramienta agéntica de código te obliga a la misma mala elección:

- **Niñerearla** — aprobar `ls`, `grep`, `find | sort` a mano, docenas de
  veces por sesión; o
- **Apagar la seguridad por completo** — modos bypass/yolo/full-auto que
  ejecutan felices un `rm -rf`, hacen push a tus remotos o leen tus credenciales.

Lo peor son los **comandos compuestos**: los agentes adoran encadenar
(`cd src && grep -rn TODO . | sort`) y la mayoría de los sistemas de permisos
evalúan las reglas de forma que una cadena nunca matchea completa — así que
hasta lo "aprobado" sigue preguntando. Ninguna regla estática lo arregla,
porque las reglas matchean strings y la seguridad es una propiedad de **cada
segmento de la cadena**.

## Cómo funciona

nightshift es un motor de decisión diminuto (`policy.js`, Node puro, cero
dependencias) que los adaptadores conectan al hook de intercepción del agente.
Para cada comando de shell:

| El comando… | Decisión |
|---|---|
| matchea un patrón destructivo/exfiltración/escalación (`rm -rf`, `git push`, `--force`, `publish`, registro/servicios, `shutdown`, credenciales, flags `--yolo`/skip-permissions…) | **deny** — bloqueo duro |
| toca rutas sensibles (`.env`, `.ssh`, `.aws`) o usa construcciones que un splitter no puede razonar (`$( )`, backticks, heredocs, `>>`) | **defer** — cae al flujo normal de permisos del agente |
| se parte en `&&` `\|\|` `;` `\|` `&` y **cada** segmento empieza con un comando read-only/seguro (`ls`, `find`, `grep`, `git status/diff/log`, `git add/commit`, `npm run/test`…) | **allow** — corre en silencio |
| cualquier otra cosa (`npx`, `docker`, `curl`, desconocidos) | **defer** |

**A prueba de fallos por construcción:** errores de parseo, construcciones
desconocidas y crashes del adaptador siempre *difieren* — puede fallar cerrado,
nunca abierto. Diferir (en vez de forzar el prompt) también significa que tus
allow-rules existentes siguen funcionando intactas.

## Agentes soportados

| Agente | Adaptador | Estado |
|---|---|---|
| Claude Code | [`adapters/claude-code.js`](adapters/claude-code.js) | ✅ estable, con instalador |
| Otros (Codex CLI, Gemini CLI, OpenCode, Cline…) | — | PRs bienvenidos: `hook del agente → policy.decide(command) → respuesta` |

El núcleo es agnóstico al agente; un adaptador son típicamente <50 líneas de
traducción de protocolo.

## Instalar (adaptador de Claude Code)

Requiere Node ≥ 18. Funciona en Windows nativo (cero dependencias — sin `jq`,
sin `bash`), macOS y Linux.

```
node install.js
```

Idempotente (re-ejecutable), respalda tu archivo de settings, hace merge sin
sobrescribir (tus allow-rules sobreviven), instala un **piso de denegación** de
~47 reglas debajo del motor, y se auto-prueba. Reinicia la sesión del agente y
verifica:

1. `/hooks` → entrada PreToolUse apuntando a `…/nightshift/claude-code.js`
2. Pide algo con comando compuesto read-only → cero prompts
3. Pide un `git push` → bloqueado

Desinstalar: `node uninstall.js` (conserva el piso de denegación a propósito).

## Para correr sin supervisión

- Sesión **interactiva** en el repo objetivo. Lo desconocido queda **pausado
  en un prompt** hasta que vuelvas — nunca se ejecuta solo.
- Desactiva la suspensión de la máquina para corridas nocturnas.
- No lo corras en carpetas con secretos o documentos personales; una capa de
  permisos no es un sandbox del SO. Para aislamiento fuerte, corre el agente
  en un contenedor o VM.
- Ojo con el consumo de tokens.

## Defaults con opinión

- **`git push` nunca se auto-ejecuta y está denegado por default** — revisa en
  la mañana y haz push tú. Para cambiarlo: quita los patrones `git push` de
  `DANGER` en `policy.js` y de `DENY_FLOOR` en `install.js`.
- **Auto-protección:** instalado, el agente no puede editar su propio archivo
  de settings ni el hook de nightshift — un agente que puede reescribir su
  sistema de permisos no tiene sistema de permisos.
- `npx`, `docker` y eval inline (`python -c`, `node -e`) nunca se auto-aprueban.
- Los flags de escalación de *cualquier* agente (`--dangerously-skip-permissions`,
  `--yolo`, `--full-auto`) se deniegan — un agente no debe poder lanzar una
  copia menos restringida de sí mismo.

## Limitaciones

- El motor es **heurístico, no un parser de shell**: lo que no entiende cae en
  *defer* (prompt), no en *allow*.
- Un `>` simple dentro de una cadena read-only sí pasa (riesgo equivalente a
  ediciones de archivo auto-aceptadas).
- Una capa de permisos complementa — nunca reemplaza — el sandboxing del SO.

## Tests

```
node test.js    # 26 casos (motor + protocolo del adaptador), CI en Windows y Linux
```

## Licencia

MIT
