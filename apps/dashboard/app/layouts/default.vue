<template>
  <div class="min-h-screen bg-slate-50 text-slate-950">
    <header class="border-b border-slate-200 bg-white/90 px-6 py-4">
      <div class="mx-auto flex max-w-6xl items-center justify-between">
        <NuxtLink class="flex items-center gap-3" to="/" aria-label="Lathe dashboard home">
          <span class="flex size-9 items-center justify-center rounded-lg bg-slate-950 text-white">
            <UIcon class="size-5" name="i-lucide-gauge" />
          </span>
          <span class="text-lg font-semibold">Lathe</span>
        </NuxtLink>

        <UBadge color="neutral" variant="soft">localhost</UBadge>
      </div>
    </header>

    <main class="mx-auto max-w-6xl px-6 py-8">
      <slot />
    </main>
  </div>
</template>
