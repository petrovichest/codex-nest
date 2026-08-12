export default {
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
  },
};
