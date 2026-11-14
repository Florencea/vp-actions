import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    cache: {
      scripts: true,
      tasks: true,
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
    },
    plugins: ["unicorn", "typescript", "oxc"],
  },
  fmt: {
    sortPackageJson: true,
  },
});
