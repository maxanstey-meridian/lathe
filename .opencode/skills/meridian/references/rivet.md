# Rivet (.NET)

Use this reference when designing or reviewing .NET APIs that use Rivet.

## What Rivet Is

Rivet reads your compiled C# with Roslyn and emits an OpenAPI 3.1 spec — no
runtime reflection, no attributes-on-everything, no drift between code and spec.
The spec plugs into the OpenAPI TypeScript ecosystem (openapi-typescript,
openapi-fetch, openapi-zod-client).

It is not your application architecture, domain model, or a reason to wrap
generated clients one-for-one. Module/use-case architecture still lives outside
Rivet. Rivet makes the API seam explicit and typed.

## Two Ways In

### 1. Contract-first (`[RivetContract]`) — preferred

A static class with `static readonly` fields built via the `Define` factory:

```csharp
[RivetContract]
public static class MembersContract
{
    public static readonly RouteDefinition<PagedResult<MemberDto>> List =
        Define.Get<PagedResult<MemberDto>>("/api/members")
            .Description("List all team members");

    public static readonly RouteDefinition<InviteMemberRequest, InviteMemberResponse> Invite =
        Define.Post<InviteMemberRequest, InviteMemberResponse>("/api/members")
            .Status(201)
            .Returns<ValidationErrorDto>(422, "Validation failed")
            .Secure("admin");
}
```

Handlers execute the contract via `.Invoke()`, so the compiler enforces that
your implementation matches the declaration — input type, output type, and
(at runtime on the typed-results path) status codes.

### 2. Annotate existing controllers (`[RivetEndpoint]`)

Mark the endpoints you want surfaced — the operation is derived from the real
transport shape (routes, params, bodies, response types):

```csharp
[RivetEndpoint]
[HttpGet("{id:guid}")]
[ProducesResponseType(typeof(TaskDetailDto), StatusCodes.Status200OK)]
[ProducesResponseType(typeof(NotFoundDto), StatusCodes.Status404NotFound)]
public async Task<IActionResult> Get(Guid id, CancellationToken ct) { ... }
```

`[RivetClient]` is a legacy alias for annotating an entire controller class;
`[RivetEndpoint]` on individual actions is the current idiom.

## Route Definition API

### Factories

| Factory | Variants | Default success |
|---|---|---|
| `Define.Get(route)` | untyped, `<TOutput>`, `<TInput, TOutput>` | 200 |
| `Define.Post(route)` | untyped, `<TOutput>`, `<TInput, TOutput>` | 201 |
| `Define.Put(route)` / `Define.Patch(route)` | untyped, `<TOutput>`, `<TInput, TOutput>` | 200 |
| `Define.Delete(route)` | untyped, `<TOutput>`, `<TInput, TOutput>` | 204 untyped, 200 typed |
| `Define.File(route)` | untyped, `<TInput>` | 200, GET, `application/octet-stream` |

Untyped definitions can become input-only via `.Accepts<TInput>()` (e.g. a PUT
that takes a body and returns 204), producing an `InputRouteDefinition<TInput>`.

### Builder methods

All return the definition for chaining.

| Method | Effect |
|---|---|
| `.Summary(text)` / `.Description(text)` | OpenAPI `summary` / `description` |
| `.Status(code)` | Override the success status. Once only. |
| `.Returns<T>(status[, description])` | Declare an additional typed response. Each status once. |
| `.Returns(status[, description])` | Same, without a payload type. |
| `.WithResponseHeader(status, name[, description][, required:])` | Response header on a status. Spec-only — handler must emit it. |
| `.WithResponseHeader(name[, description][, required:])` | Same, targeting the success status. |
| `.Secure(scheme)` | Reference a security scheme (define with `--security`). |
| `.Anonymous()` | No auth (`security: []`). |
| `.QueryAuth(name = "token")` | Auth token as required query param — for media players that cannot set headers. |
| `.FormEncoded()` | Request body is `application/x-www-form-urlencoded`. |
| `.AcceptsFile()` | Request body is `multipart/form-data` with a binary file part. **There is no `.Multipart()` — this is it.** |
| `.AcceptsBinary(contentType = "application/octet-stream")` | Request body is raw bytes. Spec-only; `TInput` properties lower to route/query params. Mutually exclusive with `.AcceptsFile()` / `.FormEncoded()`. |
| `.ProducesFile(contentType = "application/octet-stream")` | Response is a binary download. |
| `.ContentType(mediaType)` | `FileRouteDefinition` alias for `ProducesFile`. |
| `.AcceptsContentType(mediaType)` | Declared media type for a non-JSON request body (e.g. `"text/plain"`). Schema unchanged. |
| `.ProducesContentType(mediaType)` | Declared media type for a non-JSON success response (e.g. `"text/html"`). |
| `.RequestExampleJson(json, ...)` / `.ResponseExampleJson(status, json, ...)` | Attach examples. Runtime no-ops — Roslyn reads them at generation time only. |
| `.SkipValidation()` | Disable typed-result validation for framework results without a status code. |

Definitions are immutable after first `Invoke`; every builder mutator throws
post-publish. Configure fully in the `static readonly` initializer.

## File Uploads / Multipart

On controller endpoints, an `IFormFile` parameter (or collection) makes the
operation multipart automatically. On contracts, `.AcceptsFile()` marks it
explicitly:

```csharp
public static readonly RouteDefinition<UploadRequest, UploadResponse> Upload =
    Define.Post<UploadRequest, UploadResponse>("/api/files")
        .AcceptsFile();
```

`.AcceptsBinary(contentType)` declares a raw byte-stream body (chunked uploads,
audio, etc.). `TInput` properties bind to route/query params, not a JSON body.
Mutually exclusive with `.AcceptsFile()` and `.FormEncoded()`.

`Define.File(route)` declares a binary download endpoint (GET,
`application/octet-stream` unless overridden via `.ContentType()`).

## Implementing Contracts

### Controller style

```csharp
[ApiController]
[Route("api/members")]
public sealed class MembersController : ControllerBase
{
    [HttpPost]
    public async Task<IActionResult> Invite(
        [FromBody] InviteMemberRequest request, CancellationToken ct)
        => (await MembersContract.Invite.Invoke(request, async req =>
        {
            return new InviteMemberResponse(Guid.NewGuid());
        })).ToActionResult();
}
```

### Typed-results style (runtime-validated)

```csharp
[HttpPost]
public async Task<IResult> Invite(
    [FromBody] InviteMemberRequest request, CancellationToken ct)
    => await MembersContract.Invite.Invoke<Created<InviteMemberResponse>, UnprocessableEntity<ValidationErrorDto>>(
        request,
        async req =>
        {
            var result = await useCase.ExecuteAsync(req, ct);
            if (result.HasValidationErrors)
                return TypedResults.UnprocessableEntity(result.Errors);
            return TypedResults.Created($"/api/members/{result.Id}", result.Response);
        });
```

The typed-results overload validates at request time that the returned status,
payload runtime type, body presence, and content type match the declaration.
Mismatches throw `RivetContractViolationException`.

### Bridge extensions

Write once per project:

```csharp
public static class RivetExtensions
{
    public static IActionResult ToActionResult<T>(this RivetResult<T> result)
        => new ObjectResult(result.Data) { StatusCode = result.StatusCode };

    public static IActionResult ToActionResult(this RivetResult result)
        => new StatusCodeResult(result.StatusCode);

    public static IResult ToResult<T>(this RivetResult<T> result)
        => Results.Json(result.Data, statusCode: result.StatusCode);

    public static IResult ToResult(this RivetResult result)
        => Results.StatusCode(result.StatusCode);
}
```

Register the violation handler so mismatches surface as structured errors:

```csharp
builder.Services.AddExceptionHandler<RivetContractViolationHandler>();
builder.Services.AddProblemDetails();
app.UseExceptionHandler();
```

## Runtime Validation Scope

**Enforced on the typed-results `Invoke<T1..T6>` path:**
- status code is declared (success or `.Returns(...)`)
- payload runtime type matches declaration (derived types rejected unless interface/abstract/`[JsonPolymorphic]`)
- body presence and content type match
- file endpoints: success branch carries file content matching declared content type

**NOT enforced:**
- serialized JSON shape (custom converters, `[JsonExtensionData]`, null in required members)
- validation constraints (`[Range]`, `[StringLength]`, etc.) — host framework's job
- `RivetResult` plain path (compiler types only, no runtime checks)
- request parsing/binding (ASP.NET's job)
- declared headers (spec-only)
- examples (generation-time only)

## CLI

```bash
# Generate
dotnet rivet --project path/to/Api.csproj --output ./generated

# With metadata
dotnet rivet --project path/to/Api.csproj --output ./generated \
  --title "Orders API" --version 2.3.0 --server https://api.example.com --security bearer

# Contract coverage check (CI gate)
dotnet rivet --project path/to/Api.csproj --check

# Drift gate — fails if committed openapi.json is stale
dotnet rivet --project path/to/Api.csproj --output ./generated --verify

# List discovered endpoints
dotnet rivet --project path/to/Api.csproj --routes
```

`--security` accepts: `bearer`, `bearer:jwt`, `cookie:<name>`, `apikey:<in>:<name>`.

## Contract Location

Contracts live in a top-level `Contracts/{Module}/` folder with their DTOs
alongside — never inside `Modules/`.

- the contract owns route constants: `public const string CreateRoute = "/api/transcriptions";`
- minimal APIs reference them via `Contract.X.Route`; controllers via `[HttpPost(X.Route)]`
- never a literal route string in `Map*(...)` or `[Http*(...)]` — routes come from the contract
- bootstrap endpoints (`Program.cs` health, root) are the one exception

Golden example: `/Users/max/Sites/medway/speechscribe-azure/apps/api/Contracts/`

## Generated Output

Generated Rivet output lives in a workspace package — `packages/contracts` with
an `exports` map — consumed as `@app/contracts/client`, never an in-app dir.

- generated code is read-only; exclude from lint
- regenerate via the repo's task convention (`task generate`, `pnpm rivet`, or `dotnet rivet --project ... --output ...`)
- commit regenerated output with the contract change that caused it
- `--verify` is the CI drift gate

Golden example: `/Users/max/Sites/medway/speechscribe-azure/packages/contracts/`

## TypeScript Client Package

The frontend contract package has:

- `generated/openapi.json` — OpenAPI 3.1 emitted from the authored Rivet contract
- `generated/schema.d.ts` — `openapi-typescript` output over that spec
- `src/index.ts` — the hand-owned client facade consumed by UI apps

Standard facade shape:

```ts
import createOpenApiClient, { type Client, type ClientOptions } from "openapi-fetch";
import type { paths } from "../generated/schema.js";

export type { components, paths } from "../generated/schema.js";

export type RivetFetch = (input: Request) => Promise<Response>;
export type RivetConfig = Omit<ClientOptions, "baseUrl" | "fetch"> & {
  readonly baseUrl?: string;
  readonly fetch?: RivetFetch;
};
export type RivetClient = Client<paths>;

export const createClient = (config: RivetConfig = {}): RivetClient =>
  createOpenApiClient<paths>(config);

export let client: RivetClient = createOpenApiClient<paths>();

export const configureRivet = (config: RivetConfig): void => {
  client = createClient(config);
};
```

Rules:
- UI imports `client`, `createClient`, `configureRivet`, and DTO types from the contracts package
- UI does not create `openapi-fetch` clients directly
- regeneration updates `generated/`; the facade is hand-owned after scaffold
- do not wrap the generated client one-for-one in a fake API service

## Frontend Result Handling

Call generated clients with `{ unwrap: false }` and narrow on status codes:

```ts
const result = await accessClient.mappings({ unwrap: false });
if (result.isOk()) return result.data;
if (result.isNotFound()) return null;
```

`try/catch` around an `unwrap: false` call is correct for transport/network
failures — never use catch for status-code branching.

## Practical Rules

- Contract first, in top-level `Contracts/{Module}/`; routes come from contract constants
- Entire application handler body and transport mapping live inside `Invoke(...)`
- Prefer typed-results `Invoke<T1..T6>` for runtime-validated endpoints
- Use `.ToResult()` / `.ToActionResult()` for straight-through endpoints
- Use `.AcceptsFile()` for multipart uploads — there is no `.Multipart()`
- Use `.AcceptsBinary()` for raw byte streams
- Use `Define.File()` / `.ProducesFile()` for binary downloads
- Register `RivetContractViolationHandler` so mismatches surface as structured 500s
- Keep host-specific details out of the contract definition
- Do not wrap generated clients one-for-one

## Anti-patterns

- mapping routes manually instead of using `Contract.Endpoint.Route`
- doing half the work outside `Invoke(...)` without a transport-specific reason
- wrapping the generated client in another identical service layer
- mixing domain/application architecture concerns into the contract class
- using `.FormEncoded()` on an endpoint that accepts `IFormFile` / multipart
- relying on `RivetResult` plain path for runtime validation (it only checks compile-time types)
