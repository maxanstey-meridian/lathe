<template>
  <div class="min-h-dvh bg-slate-50 text-slate-950">
    <header class="border-b border-slate-200 bg-white/90 px-6 py-4">
      <div class="mx-auto flex max-w-[96rem] items-center justify-between">
        <NuxtLink class="flex items-center gap-3" to="/" aria-label="Lathe dashboard home">
          <span class="flex size-9 items-center justify-center rounded-lg bg-slate-950 text-white">
            <UIcon class="size-5" name="i-lucide-gauge" />
          </span>
          <span class="text-lg font-semibold">Lathe</span>
        </NuxtLink>

        <UBadge color="neutral" variant="soft">localhost</UBadge>
      </div>
    </header>

    <main class="mx-auto h-[calc(100dvh-73px)] max-w-[96rem] px-4 py-4 sm:px-6">
      <slot />
    </main>
  </div>
</template>
