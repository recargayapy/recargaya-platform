import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Determinismo: el spike inyecta caidas con una semilla fija.
    // Sin esto, una prueba que falla una vez cada cien no se puede reproducir.
    sequence: { shuffle: false },
  },
})
