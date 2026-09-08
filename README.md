# Cash-In Service — Challenge Técnico

Servicio de **recarga de saldo (Cash-In)** vía pasarela de pagos externa.

| | |
|---|---|
| **Stack** | NestJS + PostgreSQL + TypeORM |
| **Alcance** | Solución pequeña, bien diseñada y bien explicada (3–4 h), no una plataforma completa |
| **Idea central** | Idempotencia durable multi-pod + reconcile ante timeout + webhooks at-least-once |

---

## Índice

1. [Arranque y contrato HTTP](#1-arranque-y-contrato-http)
2. [Arquitectura propuesta](#2-arquitectura-propuesta)
3. [Estrategia de idempotencia](#3-estrategia-de-idempotencia)
4. [Pregunta central: ¿cómo no cobrar dos veces?](#4-pregunta-central-cómo-no-cobrar-dos-veces)
5. [Manejo de concurrencia](#5-manejo-de-concurrencia)
6. [Estrategia de retry](#6-estrategia-de-retry)
7. [Manejo de webhooks](#7-manejo-de-webhooks)
8. [Escenarios 1–10 del examen](#8-escenarios-110-del-examen)
9. [Observabilidad, tests y anti–red flags](#9-observabilidad-tests-y-anti–red-flags)
10. [ADRs (decisiones)](#10-adrs-decisiones)
11. [⚡ SECCIÓN CLAVE — Pilotaje del agente IA](#11--sección-clave--pilotaje-del-agente-ia)
12. [Defensa técnica — 4 preguntas (sustentadas)](#12-defensa-técnica--4-preguntas-sustentadas)

---

## 1. Arranque y contrato HTTP

### Cómo levantarlo

```bash
cd D:\EjercicioLigo
docker compose up -d          # Postgres en :5434
npm install
cp .env.example .env          # si aún no existe
npm run start:dev             # API en http://localhost:3000
```

| Check | Cómo |
|-------|------|
| Health | `GET http://localhost:3000/health` |
| Unit | `npm test` |
| E2E | `npm run test:e2e` |
| Postman | Importar `postman/Cash-In-Service.postman_collection.json` |

### Endpoints obligatorios

| Método | Path | Rol |
|--------|------|-----|
| `POST` | `/cash-in` | Inicia o reintenta un cash-in |
| `POST` | `/webhooks/payment` | Notificaciones del proveedor (at-least-once) |

#### `POST /cash-in`

**Headers**
- `Idempotency-Key: <uuid>` — **obligatorio**
- `X-Correlation-Id: <string>` — opcional (si falta, se genera)

**Body**
```json
{
  "user_id": "usr_abc123",
  "amount": 100.00,
  "currency": "PEN",
  "payment_method": "card_xyz"
}
```

**Response `200`**
```json
{
  "operation_id": "op_9f8e7d6c5b4a",
  "status": "completed",
  "amount": 100,
  "new_balance": 350
}
```

**Simulación del mock PSP** (sufijo de `payment_method`):

| Sufijo | Efecto |
|--------|--------|
| `*_fail` | Proveedor rechaza |
| `*_timeout` | Timeout; el cobro **pudo** ocurrir en el PSP |
| (resto) | Éxito |

---

## 2. Arquitectura propuesta

Alineada al slide **Contexto del Problema**:

```
APP ──► API (NestJS) ──► Cash-In Service
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
   Payment Provider     Wallet / Ledger           DB
   (puerto + mock)      (saldo + créditos)   (Postgres)
```

En este challenge las cajas son **límites lógicos** dentro de un **modular monolith** NestJS (válido y preferible en 3–4 h; no hace falta desplegar 5 microservicios).

```
src/
├── cash-in/             → Cash-In Service (claim, charge/reconcile, complete)
├── wallet/              → Wallet / Ledger
├── payment-provider/    → Payment Provider (interface + mock)
├── webhooks/            → Webhooks at-least-once + replay
├── common/              → correlation-id, logs, retry de infra
├── config/ + health/
└── (Postgres)           → DB: operations, wallets, ledger_entries, webhook_events
```

| Capa | Responsabilidad | Por qué existe |
|------|-----------------|----------------|
| `CashInController` | Contrato HTTP + validación | Separar transporte de negocio |
| `CashInService` | Orquesta claim → replay → charge/reconcile → complete | **Un solo lugar decide si se cobra** |
| `operation.state-machine` | Transiciones legales | Webhooks fuera de orden no rompen el dominio |
| `WalletService` | Crédito atómico | Race de saldo entre pods |
| `PaymentProvider` | Puerto hexagonal | El mock no contamina el dominio |
| `WebhooksService` / `WebhookReplayService` | Dedupe + buffer + apply | At-least-once real |
| PostgreSQL | Fuente de verdad | Multi-pod + reinicios + auditoría |

**Stateless del proceso:** no hay idempotencia de negocio en `Map`/memoria del pod. El `Map` del mock **solo simula al PSP externo**.

### Modelo de datos

| Tabla | Rol |
|-------|-----|
| `operations` | 1 fila por `Idempotency-Key` (`UNIQUE`). Status, hash del body, snapshot de respuesta |
| `wallets` | Saldo por usuario + lock pesimista al acreditar |
| `ledger_entries` | Append-only; `UNIQUE(operation_id)` ⇒ crédito 1× |
| `webhook_events` | `UNIQUE(provider_event_id)`; `buffered` / `applied` / `ignored` |

---

## 3. Estrategia de idempotencia

### Objetivo

Misma `Idempotency-Key` + mismo body ⇒ **mismo efecto** (1 cobro, 1 crédito, misma respuesta), aunque haya doble click, retry de app, 5 pods o reinicio.

### Mecanismo multi-pod (claim atómico)

```
Cliente          Pod A / B / C                 PostgreSQL
  │                   │                             │
  │  Idempotency-Key=K│  INSERT operations(K)       │
  │──────────────────►│────────────────────────────►│
  │                   │      UNIQUE(K)              │
  │                   │◄── winner  /  23505 ────────│
  │                   │                             │
  │                   │  winner  → charge(K)        │
  │                   │  followers → wait/reconcile │
  │                   │  (NUNCA charge de nuevo)    │
```

Pasos en `CashInService`:

1. **Claim:** `INSERT` con `UNIQUE(idempotency_key)`.
2. **Winner:** cobra (o aplica webhook buffered).
3. **Followers** (error `23505`): leen la fila; si está terminal devuelven snapshot; si in-flight esperan/reconcilian; **no llaman `charge`**.
4. **`request_hash`:** misma key + body distinto → `409 Conflict`.
5. Al PSP se manda **la misma K** (el proveedor también debe ser idempotente).

---

## 4. Pregunta central: ¿cómo no cobrar dos veces?

> El proveedor cobra S/100. Antes de responder, ocurre un timeout. No sabes si el cobro se realizó. El cliente reintenta.  
> **¿Cómo evitas cobrar dos veces?**  
> *(No hay una única respuesta correcta. Evalúan el razonamiento.)*

### Nuestra respuesta (implementada)

**No reintentamos el cobro. Idempotencia de punta a punta + reconciliación.**

### Secuencia

1. Cliente `POST /cash-in` con `Idempotency-Key=K`.
2. Claim `INSERT operations(K)`.
3. `provider.charge(K)` → **timeout** (respuesta perdida; en el PSP el cobro pudo quedar OK).
4. Marcamos `provider_unknown`. **No** `failed`. **No** `charge()` otra vez.
5. Cliente reintenta con la **misma K**.
6. Camino follower → `getPaymentByIdempotencyKey(K)`:
   - `succeeded` → `completeAfterProviderSuccess` (crédito 1×)
   - `failed` → `failed`
   - aún desconocido → devolvemos `provider_unknown`; el **webhook** cierra después
7. Webhook `payment.succeeded` (aunque llegue 2 veces): `UNIQUE(event_id)` + complete idempotente.

### Tres candados

| Candado | Garantía | Dónde |
|---------|----------|--------|
| Misma K hacia el PSP | El PSP no crea un 2º cargo | Mock / PSP real |
| `UNIQUE(idempotency_key)` | Un solo dueño de la operación | Tabla `operations` |
| Ledger `UNIQUE(operation_id)` + lock | El saldo sube una sola vez | `WalletService` |

### Anti-patrones (incorrectos)

- ❌ `catch (timeout) { charge() otra vez }` → doble cobro.
- ❌ Marcar `failed` tras timeout → inconsistencia si luego llega webhook OK.
- ❌ Nueva key en el retry del cliente → rompe idempotencia.

### Evidencia

- Unit: `provider timeout: does not charge again on client retry; reconciles instead`
- E2E: `provider timeout then retry reconciles without double charge`
- Postman: requests **4 → 5**

---

## 5. Manejo de concurrencia

| Escenario | Riesgo | Mitigación |
|-----------|--------|------------|
| 5 pods, misma key | Doble cobro | UNIQUE + followers sin `charge` |
| Doble click / retry app | Doble crédito | Snapshot + ledger UNIQUE |
| Race de saldo | Saldo incorrecto | `SELECT FOR UPDATE` + `ON CONFLICT` |
| Webhook + API a la vez | Doble complete | Lock de operación + complete idempotente |
| Webhook duplicado | Doble side-effect | `UNIQUE(provider_event_id)` |
| Reinicio mid-flight | Op colgada | Resume stale (`UPDATE` condicional) + misma K al PSP |
| `23505` dentro de TX | 500 en carreras | `INSERT … ON CONFLICT DO NOTHING` |

---

## 6. Estrategia de retry

### Sí se reintenta (solo infra)

`withTransientRetry` con backoff exponencial para:

- `ECONNREFUSED`, `ETIMEDOUT`
- Postgres `40001` (serialization), `40P01` (deadlock)
- connection terminated / temporarily unavailable

### No se reintenta a ciegas (financiero)

| Operación | ¿Retry automático? | Alternativa |
|-----------|--------------------|-------------|
| `charge()` tras timeout | **No** | `provider_unknown` + reconcile / webhook |
| `charge()` tras decline | **No** | `failed` + misma respuesta en retry del cliente |
| Misma key, body distinto | **No** | `409 Conflict` |

El retry **del cliente HTTP** es seguro solo si reenvía la **misma** `Idempotency-Key`.

---

## 7. Manejo de webhooks

Asumimos entrega **at-least-once** (nunca “llegan una sola vez”).

1. Persistir con `provider_event_id UNIQUE` → si existe: `duplicate`.
2. Resolver operación por `provider_payment_id` o `idempotency_key`.
3. Si aún no hay operación → **`buffered`** (no se pierde).
4. Si hay operación → state machine (solo transiciones legales).
5. En el próximo `/cash-in`, **antes de cobrar**, se hace replay de buffered.

### Máquina de estados

```
created ──► pending_payment ──► payment_confirmed ──► completed
   │              │                    │
   │              ├──► provider_unknown ┘
   │              └──► failed
   ├──► payment_confirmed / completed   (webhook early)
   └──► failed
```

Terminales: `completed`, `failed`.

---

## 8. Escenarios 1–10 del examen

| # | Escenario | Cómo lo cubrimos |
|---|-----------|------------------|
| 1 | Doble click | Misma key → claim UNIQUE + snapshot |
| 2 | Retry automático app | Igual: no re-cobra |
| 3 | Múltiples pods | Winner INSERT; followers sin charge |
| 4 | Timeout proveedor | `provider_unknown` + reconcile |
| 5 | Webhook duplicado | UNIQUE `event_id` |
| 6 | Webhook fuera de orden | State machine / ignore stale |
| 7 | Webhook antes que API | `buffered` + replay |
| 8 | Fallo temporal DB | Retry solo infra |
| 9 | Reinicio mid-op | Estado en DB + resume stale |
| 10 | Race de saldo | Lock + ledger UNIQUE |

---

## 9. Observabilidad, tests y anti–red flags

### Observabilidad

- Header `X-Correlation-Id` (middleware + response).
- `correlation_id` en cada operación.
- Logs JSON: `request_completed` / `request_failed` / `transient_retry`.

### Tests

```bash
npm test
npm run test:e2e
```

Cobertura: success, idempotencia, multi-pod, provider fail, timeout+reconcile, webhook dup, webhook early, race saldo, retry DB, stale resume, state machine.

### Anti–red flags

| Red flag | ¿En este repo? | Cómo se evita |
|----------|----------------|---------------|
| Idempotencia solo en memoria | No | UNIQUE Postgres |
| No considera multi-pod | No | Claim INSERT + followers |
| Acepta código del agente sin cuestionar | No | ADRs + correcciones documentadas |
| No puede explicar por qué el agente propuso X | No | Sección 11 y 12 |
| Retry indiscriminado financiero | No | Nunca `charge` tras timeout |
| Confía en webhook único | No | UNIQUE event_id + tests |
| No escribe pruebas | No | Unit + e2e |

---

## 10. ADRs (decisiones)

1. **Idempotencia en Postgres** (no memoria / no “solo Redis”) — multi-pod + auditoría.
2. **Estado `provider_unknown`** — timeout ambiguo sin re-cobrar.
3. **Ledger + `ON CONFLICT`** — un crédito aunque complete corra N veces.
4. **Followers nunca cobran** — solo el winner del claim.
5. **Webhooks buffered + replay** — webhook early no se pierde.

---

## 11. ⚡ SECCIÓN CLAVE — Pilotaje del agente IA

### Qué se le pidió (specs / prompts)

1. Cumplir slides: contrato, escenarios 1–10, entregables, rúbrica, red flags.
2. NestJS senior: idempotencia multi-pod real, state machine, webhooks robustos.
3. Resolver timeout **sin doble cobro**.
4. Solución pequeña y explicada (3–4 h) + tests + README con ADRs.
5. Documentar qué falló del agente y qué se corrigió a mano.

### Qué resolvió mal y cómo se corrigió

| Pedido | Fallo típico del agente | Corrección |
|--------|-------------------------|------------|
| Idempotencia multi-pod | `Map` en memoria | `UNIQUE(idempotency_key)` + snapshot |
| Timeout sin doble cobro | Reintentar `charge` | `provider_unknown` + reconcile |
| Concurrencia misma key | Followers re-procesaban | Followers solo wait/reconcile/resume |
| Webhook early | Ignorar y perder evento | `buffered` + replay |
| Carreras wallet/ledger | `catch(23505)` abortaba TX | `ON CONFLICT DO NOTHING` |
| Scope | Kafka/CQRS de más | Modular monolith mínimo |

### Qué sí se aceptó (con criterio)

- NestJS modular, TypeORM+Postgres, puerto `PaymentProvider`, state machine explícita.

---

## 12. Defensa técnica — 4 preguntas (sustentadas)

> Slide **Defensa Técnica**. Cada respuesta incluye: qué responder, por qué es correcta, evidencia y límite honesto.

### 12.1 “5 pods reciben el mismo Idempotency-Key simultáneamente, ¿qué garantiza que solo uno procese la operación?”

**Respuesta oral (30 s):**  
“Lo garantiza PostgreSQL con `UNIQUE(idempotency_key)`. Los cinco hacen `INSERT`; uno gana y los otros cuatro reciben `23505`. Esos cuatro son *followers*: leen la operación existente, esperan o reconcilian, y **no llaman al proveedor**. La garantía no es un mutex de Node: ese no se comparte entre pods.”

**Detalle técnico**
1. Claim = `INSERT` atómico.
2. Winner → `charge(K)`.
3. Followers → snapshot / reconcile / resume stale.
4. El PSP también recibe la misma K (segundo candado).

**Evidencia:** unit `multi-pod: 5 concurrent…` + e2e homónimo.  
**Límite:** UNIQUE asegura un claim de negocio; el PSP debe honorar la misma idempotency key (requisito contractual).

---

### 12.2 “¿Qué le pediste al agente que no resolvió bien? ¿Cómo lo corregiste?”

**Respuesta oral:**  
“Le pedí idempotencia multi-pod y manejo de timeout. Primero propuso memoria y reintentar `charge`. Lo rechacé. Forcé claim en Postgres, estado `provider_unknown`, followers sin cobro, buffer de webhooks y `ON CONFLICT` en ledger porque un `catch` de unique dentro de la TX abortaba Postgres en carreras.”

Usa la tabla de la [sección 11](#11--sección-clave--pilotaje-del-agente-ia). Eso demuestra el 15% de **pilotaje IA** de la rúbrica.

---

### 12.3 “¿Cuándo usarías Redis vs base de datos para idempotencia?”

**Respuesta oral:**  
“No es Redis *o* DB: es qué garantía necesito. Para verdad de negocio auditable (quién cobró, saldo, respuesta) uso **Postgres**. Redis lo usaría como complemento: locks cortos, rate-limit o cache del snapshot con TTL. En este cash-in la idempotencia financiera vive en DB; moverla solo a Redis arriesga durabilidad y auditoría.”

| Necesidad | Elige | Motivo |
|-----------|-------|--------|
| Auditoría / saldo / claim durable | **Postgres** | ACID + UNIQUE + joins |
| Lock corto / cache caliente | **Redis** (extra) | Latencia + TTL |
| Este challenge | **DB** | Correctitud > micro-optimización |

**Lo que no diría:** “Redis porque es más rápido”, sin hablar de persistencia.

---

### 12.4 “¿Qué cambiarías si este servicio procesara 1 millón de operaciones al día?”

**Respuesta oral:**  
“1M/día es ~12 rps promedio; el diseño aguanta con tuning. No reescribiría la semántica de idempotencia. Cambiaría operación: PgBouncer, migraciones (sacar `synchronize`), archivado de tablas, completar async con outbox manteniendo el claim síncrono, cola para webhooks, métricas de `provider_unknown`, y opcionalmente cache Redis del snapshot con fallback a DB. Seguiría prohibido el retry ciego de `charge`.”

**Prioridad de cambios**
1. Pooling + migraciones + retención de datos  
2. Async del cobro (API puede devolver `provider_unknown` / pending; cliente reintenta con misma K)  
3. Inbox/outbox de webhooks  
4. Métricas y job de reconcile de ops colgadas  
5. Redis solo como cache/lock, **no** como fuente de verdad  

**Por qué es sustentable:** escalas I/O y operación; no inventas otra semántica financiera.

---

## Estructura y variables

```
src/cash-in | wallet | payment-provider | webhooks | common | config | health
test/cash-in.e2e-spec.ts
postman/Cash-In-Service.postman_collection.json
docker-compose.yml
```

| Variable | Default | Uso |
|----------|---------|-----|
| `DB_PORT` | `5434` | Postgres |
| `PROVIDER_MODE` | `success` | Mock PSP |
| `DB_RETRY_ATTEMPTS` | `3` | Retry solo infra |
| `FOLLOWER_WAIT_MS` | `1500` | Espera de followers |
| `STALE_OPERATION_MS` | `3000` | Resume tras reinicio |
