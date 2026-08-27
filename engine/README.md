# Comic30 internal creation engine

`comic30_engine/core.py` is the isolated deterministic creation process for Story, Scenes, Levels, Characters, Gameplay, World/Terrain, and Economy. It accepts one JSON document on standard input and emits one JSON document on standard output.

The Node HTTP service owns authentication, persistence, packaging, downloads, deployments, analytics, and orchestration. It invokes this process when Python is available and uses the matching deterministic Node implementation when it is not.

This module produces editable game blueprints and runtime data. Shader validation, navigation baking, LOD generation, and asset optimization are persisted pipeline operations. It is not a native Vulkan renderer or a replacement for platform SDK signing; Android/iOS store-ready binaries still require their respective native toolchains and signing credentials.
