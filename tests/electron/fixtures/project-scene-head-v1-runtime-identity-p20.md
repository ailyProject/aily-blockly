# Current canonical Project Scene head fixture

`project-scene-head-v1-runtime-identity-p20.json` is a separate offline codec fixture. It is 64,869 bytes with SHA-256 `15bd53c615cb3bccbfe9fec4f07fbf28fec41efdd0054a54203672029d348d1f`.

Its topology, component configurations, instance IDs, placement and presentation were copied unchanged from Simulator's historical `packages/simulator-protocol/test/fixtures/project-scene-head-v1-real.json` (64,912 bytes, SHA-256 `64c675abc4090bd9493470e715f0f7b1d75c476f268fd68a146b96a02a3d5158`). The historical file, its graph revision and storage revision remain unchanged. The current strict canonical validator rejects that historical head; this test does not claim old-project compatibility.

For this new fixture only, the four `ailySimulatorComponentPackage` references were selected by exact package ID, version and unchanged scene recipe from the current public Component registry. Their old `contentSha256` locks became `runtimeSha256` locks. Full Component content and runtime identity are separate; this is not an automatic migration or proof that an old firmware Artifact matches the new graph.

| Instance | Runtime SHA-256 |
| --- | --- |
| xiao_esp32s3_1 | 4b19e4d16e35cc69d11fe6719b1f2d263447a13bd01bb23f0af1313f97e09535 |
| resistor_1 | 0cac591c2c1a83a3a29647c52cea62fba75bf496556d6f2cf8117c288868ae47 |
| led_1 | 23037f40ee7598a480e2ce3a0e382f1d1d8c0057e932cd28366cd43bc649fd7e |
| button_1 | f9126faf376d15b53057399e00fabb0e62b3eff072c6f1aed6c0bcbd831aef28 |

The official Scene APIs `recomputeSceneEditorDocumentV2Revisions` and `verifySceneEditorDocumentV2Revisions` produced and verified the document. The public codec's `createProjectSceneHeadV1` and `encodeProjectSceneHeadV1` produced the stored bytes under a new commit ID. A deep comparison excluding only the four package identities and document revisions confirmed that the remaining document was unchanged.

New graph revision: `7698b0e652ee93a08374b0d39ce4771b7f0c491648a8efe69e5cb59cff10b39a`.
New visual revision: `09771c763d2ed25e0a63642c1e361fa8e691dd8fbebb5752883098440658a9f0`.
New storage revision: `9fba5aef96d7a6faa1696cd046903bf0e9f10bf439f81dac5fb2e0bf50cfa387`.

The callback tests separately assert strict rejection and zero rewrite of the historical file, current-head byte-for-byte roundtrip/CAS, and corruption rejection starting from this valid current head. They do not compile firmware, modify user projects or execute a Runtime.
