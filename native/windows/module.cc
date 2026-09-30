#include "common.hpp"
static napi_value initialize(napi_env env, napi_value exports) {
  kiteline::exportJobs(env, exports);
  kiteline::exportSystem(env, exports);
  kiteline::exportPipes(env, exports);
  kiteline::exportFiles(env, exports);
  kiteline::exportNetwork(env, exports);
  return exports;
}
NAPI_MODULE(kiteline_windows, initialize)
