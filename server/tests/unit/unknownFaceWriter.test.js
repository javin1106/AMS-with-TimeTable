const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { deleteUnknownFacesForReport } = require('../../src/modules/attendanceModule/controllers/unknownFaceWriter');

describe('deleteUnknownFacesForReport', () => {
  let root;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'ams-unknown-faces-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seedCluster(name, sessionId) {
    const directory = path.join(root, 'BTECH', 'CSE', '2027', name);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, 'metadata.json'),
      JSON.stringify({ sessionId }),
    );
    await fs.writeFile(path.join(directory, 'representative.jpg'), 'face');
    return directory;
  }

  it('removes only clusters belonging to the deleted attendance report', async () => {
    const target = await seedCluster('target', 'report-1');
    const other = await seedCluster('other', 'report-2');

    const result = await deleteUnknownFacesForReport('report-1', root);

    expect(result).toEqual({ clustersDeleted: 1 });
    await expect(fs.access(target)).rejects.toThrow();
    await expect(fs.access(other)).resolves.toBeUndefined();
  });
});
