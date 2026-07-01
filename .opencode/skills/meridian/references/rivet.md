# Rivet (.NET)

Use this reference when designing or reviewing Meridian-style `.NET` APIs that use Rivet.

## What Rivet Is

Rivet is the typed API boundary.

It gives you:

- an authored contract surface
- generated clients/types/OpenAPI from that surface
- a runtime wrapper that enforces the contract shape at the transport edge

It is not:

- your application architecture
- your domain model
- a reason to wrap generated clients one-for-one

Your module/use-case architecture still lives outside Rivet. Rivet just makes the API seam explicit and typed.

## Meridian Default

Prefer explicit `[RivetContract]` contract classes and implement them with minimal API `*Endpoints.cs` classes.

That is the greenfield default.

Why:

- the contract is the source of truth, not controller attributes scattered across methods
- route, status, and error shape are authored once
- minimal API endpoint classes keep the transport layer thin and obvious
- the full handler body can sit inside `Contract.Endpoint.Invoke(...)`, which makes the contract boundary explicit
- explicit typed transport results in the endpoint lambda are often clearer than flattening everything through a generic helper
- the generated client stays stable even if the host style changes later

Controllers are still acceptable when ASP.NET transport concerns genuinely earn them:

- cookies / auth flows
- file uploads / file results
- attribute-heavy framework integration
- existing controller-based codebases

## Authoring Style

### 1. Contract-first

Each module owns an explicit static contract class:

```csharp
[RivetContract]
public static class AuthContract
{
    public static readonly RouteDefinition<LoginRequest, AuthResponse> Login =
        Define.Post<LoginRequest, AuthResponse>("/api/auth/login")
            .Status(200)
            .Returns<ErrorResponse>(401)
            .Returns<ErrorResponse>(422);
}
```

Rules:

- prefer `[RivetContract]` as the authored seam
- define explicit success statuses when they are not the default you want
- define expected error responses explicitly
- keep request/response DTOs near the module that owns them
- use `[RivetType]` only for types not reachable from any contract endpoint

Golden examples:

- `/Users/max/Sites/medway/speechscribe-azure/apps/api/Contracts/` (top-level
  Contracts/{Module}/ — the settled location; casebridge's module-colocated
  contracts are migration backlog, do not copy them)
- `/Users/max/Sites/meridian/reel/server/Reel.Server/ReelContract.cs`

### 2. Minimal API by default

On greenfield, prefer endpoint classes over controllers:

```csharp
public static class CaseTypesEndpoints
{
    public static IEndpointRouteBuilder MapCaseTypeEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost(
            CaseTypesContract.Create.Route,
            async (
                CreateCaseTypeRequest request,
                CreateCaseTypeUseCase useCase,
                CancellationToken cancellationToken
            ) =>
                await CaseTypesContract.Create.Invoke<
                    Created<CreateCaseTypeResponse>,
                    UnprocessableEntity<ErrorResponse>>(
                    request,
                    async incomingRequest =>
                    {
                        var result = await useCase.ExecuteAsync(
                            new CreateCaseTypeCommand(incomingRequest.Name),
                            cancellationToken
                        );

                        if (result.HasValidationErrors)
                        {
                            return TypedResults.UnprocessableEntity(
                                new ErrorResponse("validation_failed", "Validation failed.", result.Errors)
                            );
                        }

                        return TypedResults.Created(
                            $"/api/case-types/{result.CaseType!.Id}",
                            new CreateCaseTypeResponse(result.CaseType.Id)
                        );
                    }
                )
        );

        return endpoints;
    }
}
```

Rules:

- one `*Endpoints.cs` file per module/capability group
- expose a single `MapXEndpoints(this IEndpointRouteBuilder endpoints)` method
- `Program.cs` should compose endpoint groups, not contain handler bodies
- use `Contract.Endpoint.Route` when mapping
- make the outer ASP.NET endpoint handler an expression-bodied lambda; do not use a block body plus `return await` for Rivet mappings
- prefer explicit `TypedResults` in the endpoint lambda when the endpoint has meaningful HTTP branching
- use `.ToResult()` only for the straight-through cases where it genuinely keeps the endpoint smaller

Golden examples:

- explicit typed-result style:
  - use the pattern above as the default
- `/Users/max/Sites/meridian/reel/server/Reel.Server/Endpoints/CollectionEndpoints.cs`
- `/Users/max/Sites/meridian/reel/server/Reel.Server/Endpoints/HealthEndpoints.cs`
- `/Users/max/Sites/meridian/reel/server/Reel.Server/RivetExtensions.cs`

### 3. Wrap the full handler body in the Rivet lambda

The application work and transport mapping belong inside `Invoke(...)`:

```csharp
endpoints.MapPost(
    UsersContract.Create.Route,
    async (
        CreateUserRequest request,
        CreateUserUseCase createUser,
        CancellationToken ct
    ) =>
        await UsersContract.Create.Invoke<
            Created<CreateUserResponse>,
            UnprocessableEntity<ErrorResponse>>(
            request,
            async req =>
            {
                var result = await createUser.ExecuteAsync(new CreateUserCommand(req.Name), ct);

                if (result.HasValidationErrors)
                {
                    return TypedResults.UnprocessableEntity(
                        new ErrorResponse("validation_failed", "Validation failed.", result.Errors)
                    );
                }

                return TypedResults.Created(
                    $"/api/users/{result.User!.Id}",
                    new CreateUserResponse(result.User.Id)
                );
            }
        )
);
```

That is the key style rule.

Inside the lambda:

- validate application input
- call use cases / ports / repositories
- map domain/application results to API DTOs
- throw domain/application exceptions that your normal error pipeline translates

Outside the lambda:

- host wiring (`MapPost`, `[HttpPost]`, DI parameters)
- only the transport-only concerns that genuinely cannot live inside the contract result model

The outer ASP.NET endpoint lambda should stay expression-bodied. If you need branching, put the block body inside the
Rivet `Invoke(...)` lambda so the contract boundary remains visually obvious.

Prefer transport mapping inside the lambda when the endpoint has meaningful branching.

Use `.ToResult()` / `.ToActionResult()` only when the endpoint is effectively straight-through:

- invoke use case
- return one success shape
- rely on central exception handling for failures

Examples:

- CaseBridge controller style:
  - `/Users/max/Sites/medway/casebridge/api/CaseBridge/Modules/Auth/AuthController.cs`
  - `/Users/max/Sites/medway/casebridge/api/CaseBridge/Modules/Forms/FormsController.cs`
- Minimal API style:
  - `/Users/max/Sites/meridian/reel/server/Reel.Server/Endpoints/CollectionEndpoints.cs`
- Rivet’s own handoff example:
  - `/Users/max/Sites/medway/rivet-ts/docs/guides/dotnet-handoff.md`

### 4. Transport edge converts once

Keep one small extension for Rivet result conversion:

```csharp
public static class RivetExtensions
{
    public static IResult ToResult<T>(this RivetResult<T> result) =>
        Results.Json(result.Data, statusCode: result.StatusCode);
}
```

or controller variant:

```csharp
public static IActionResult ToActionResult<T>(this RivetResult<T> result) =>
    new ObjectResult(result.Data) { StatusCode = result.StatusCode };
```

Golden examples:

- `/Users/max/Sites/medway/casebridge/api/CaseBridge/Common/RivetExtensions.cs`
- `/Users/max/Sites/meridian/reel/server/Reel.Server/RivetExtensions.cs`

## Controllers vs Minimal APIs

Default recommendation:

- prefer minimal API `*Endpoints.cs` classes for greenfield
- prefer `IEndpointRouteBuilder`, not `WebApplication`, as the extension target
- prefer explicit typed results inside `Invoke(...)` when the endpoint has meaningful HTTP branches

When controllers are better:

- auth/cookie flows where controller ergonomics are genuinely clearer
- file uploads/downloads
- existing attribute/filter usage you actually want
- legacy controller-heavy apps where migration is not worth it yet

CaseBridge today is mostly controller-based, but the Rivet pattern is still the same:

- contract owns the route/status/error surface
- controller method delegates almost immediately to `Contract.Endpoint.Invoke(...)`
- result is converted once at the edge

Examples:

- controller-first:
  - `/Users/max/Sites/medway/casebridge/api/CaseBridge/Modules/Auth/AuthController.cs`
  - `/Users/max/Sites/medway/casebridge/api/CaseBridge/Modules/Notifications/NotificationsController.cs`
- minimal API:
  - `/Users/max/Sites/meridian/reel/server/Reel.Server/Endpoints/CollectionEndpoints.cs`

## `[RivetClient]` vs `[RivetContract]`

Default:

- use `[RivetContract]`

`[RivetClient]` is acceptable as the shortcut mode when:

- extracting clients from an existing controller quickly
- the endpoint is very transport-specific
- the app is small and you do not want to author a first-class contract layer yet

Do not treat `[RivetClient]` as the house-style default for serious APIs.

CaseBridge example where `[RivetClient]` is still reasonable:

- `/Users/max/Sites/medway/casebridge/api/CaseBridge/Modules/Files/FilesController.cs`

## Contract Location

Contracts live in a top-level `Contracts/{Module}/` folder, with their DTOs
alongside — never inside `Modules/`. (Settled 2026-06-10; the module-colocated
style CaseBridge currently uses is explicitly non-default and is migration
backlog.)

- the contract owns route constants: `public const string CreateRoute = "/api/transcriptions";`
- minimal APIs reference them via `Define.Post(CreateRoute)` / `Contract.X.Route`
- controllers source attributes from them: `[HttpPost(TranscriptionsContract.CreateRoute)]`
- never a literal route string in `Map*(...)` or `[Http*(...)]` — routes come from
  the contract. (Bootstrap ops endpoints in `Program.cs` — health, root — are the
  one exception: they have no contract to come from.)

Golden example: `/Users/max/Sites/medway/speechscribe-azure/apps/api/Contracts/`

## Generated Output

Generated Rivet output lives in a workspace package — `packages/contracts` with an
`exports` map — consumed as `@app/contracts/client`, never an in-app dir like
`ui/generated/rivet/`. (Settled 2026-06-10: the package boundary makes read-only
structural.)

- generated code is read-only; every file carries the generated header
- exclude the generated dir from lint (`packages/contracts/generated/**`)
- regenerate via the repo's task convention (`pnpm rivet` →
  `dotnet rivet --project ... --output ...`); commit regenerated output with the
  contract change that caused it
- customize transport by injecting `fetch` into `configureRivet({ fetch })` in the
  bootstrap plugin — never by editing or wrapping generated code

Golden example: `/Users/max/Sites/medway/speechscribe-azure/packages/contracts/`

## Frontend Result Handling

Call generated clients with `{ unwrap: false }` and narrow on the result —
status codes as values, no exceptions:

```ts
const result = await accessClient.mappings({ unwrap: false });
if (result.isOk()) return result.data;
if (result.isNotFound()) return null;
```

(Settled 2026-06-10. The unwrap-and-throw style — default unwrap plus
`try/catch` with `RivetError` and error-code extraction — is the legacy
CaseBridge shape and is migration backlog.)

`try/catch` around an `unwrap: false` call is still correct for what it is
actually for: transport/network failures, which throw regardless of the option.
Catch those to set an error state; never use catch for status-code branching.

## Practical Rules

- Rivet contract first, in top-level `Contracts/{Module}/`; routes come from
  contract constants.
- Minimal API `*Endpoints.cs` by default on greenfield.
- Use `IEndpointRouteBuilder` for endpoint mapping extensions.
- Entire application handler body and normal transport mapping live inside `Invoke(...)`.
- Prefer explicit `TypedResults` in the Rivet lambda for non-trivial endpoints.
- Use `.ToResult()` / `.ToActionResult()` as the convenience path for straight-through endpoints.
- Keep host-specific details out of the contract definition.
- Do not wrap generated clients one-for-one.

## Anti-patterns

- treating controllers as the only authored API seam when a contract layer exists
- mapping routes manually instead of using `Contract.Endpoint.Route`
- doing half the work outside the `Invoke(...)` lambda without a transport-specific reason
- wrapping the generated client in another identical service layer
- mixing domain/application architecture concerns into the contract class
