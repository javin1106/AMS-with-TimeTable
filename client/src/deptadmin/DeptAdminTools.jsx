import { useOutletContext } from 'react-router-dom';
import GroundTruthRTSP from '../attendancemodule/groundtruthgen_rtsp';
import RollAssign from '../attendancemodule/rollassign';
import GroundTruthUpload from '../attendancemodule/groundtruthupload';
import AttendanceReport from '../attendancemodule/AttendanceReport';
import FrameVerification from '../attendancemodule/FrameVerification';
import EmbeddingGeneration from '../attendancemodule/EmbeddingGeneration';
import ConfidenceMonitor from '../attendancemodule/confidenceMonitor';

const gtRollDepartments = ({ batchDepartments, batchDepartment }) => {
    const assigned = (batchDepartments || []).filter(Boolean);
    return assigned.length ? assigned : [batchDepartment].filter(Boolean);
};

export function DeptLiveRTSP() {
    const context = useOutletContext();
    const { fullAccess, loading } = context;
    if (loading) return null;
    if (fullAccess) return <GroundTruthRTSP />;
    const departments = gtRollDepartments(context);
    if (!departments.length) return null;
    const fixedDepartment = departments.length === 1 ? departments[0] : '';
    return (
        <GroundTruthRTSP
            fixedDepartment={fixedDepartment}
            departmentRestricted
        />
    );
}

export function DeptAssignRolls() {
    const context = useOutletContext();
    const { fullAccess, loading } = context;
    if (loading) return null;
    if (fullAccess) return <RollAssign />;
    const departments = gtRollDepartments(context);
    if (!departments.length) return null;
    const fixedDepartment = departments.length === 1 ? departments[0] : '';
    return <RollAssign fixedDepartment={fixedDepartment} />;
}

export function DeptGroundTruthUpload() {
    const { department, batchDepartment, fullAccess, loading } = useOutletContext();
    if (loading) return null;
    if (fullAccess) return <GroundTruthUpload />;
    const deptToUse = batchDepartment || department;
    if (!deptToUse) return null;
    return <GroundTruthUpload fixedDepartment={deptToUse} />;
}

export function DeptAttendanceReport() {
    const { department, batchDepartment, fullAccess, loading } = useOutletContext();
    if (loading) return null;
    if (fullAccess) return <AttendanceReport />;
    const deptToUse = batchDepartment || department;
    if (!deptToUse) return null;
    return <AttendanceReport fixedDepartment={deptToUse} />;
}

export function DeptClassVerification() {
    const { department, batchDepartment, fullAccess, loading } = useOutletContext();
    if (loading) return null;
    if (fullAccess) return <FrameVerification />;
    const deptToUse = department || batchDepartment;
    if (!deptToUse) return null;
    return <FrameVerification fixedDepartment={deptToUse} />;
}

export function DeptSubjectEmbeddings() {
    const { department, batchDepartment, fullAccess, loading } = useOutletContext();
    if (loading) return null;
    if (fullAccess) return <EmbeddingGeneration />;
    const deptToUse = department || batchDepartment;
    if (!deptToUse) return null;
    return <EmbeddingGeneration fixedDepartment={deptToUse} />;
}

export function DeptConfidenceMonitor() {
    const { department, batchDepartment, fullAccess, loading } = useOutletContext();
    if (loading) return null;
    if (fullAccess) return <ConfidenceMonitor />;
    const deptToUse = department || batchDepartment;
    if (!deptToUse) return null;
    return <ConfidenceMonitor fixedDepartment={deptToUse} />;
}
