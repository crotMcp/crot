# AD-29. Explicit administrator host preparation. Never called by CrotService.
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
if ($Apply -and -not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw '-Apply requires an explicitly administrator-started PowerShell.'
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
public static class CrotNullPreparation {
  [StructLayout(LayoutKind.Sequential)] struct US { public ushort Length, MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OA { public int Length; public IntPtr RootDirectory, ObjectName; public uint Attributes; public IntPtr SecurityDescriptor, SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public IntPtr Status, Information; }
  [DllImport("ntdll.dll")] static extern int NtOpenFile(out IntPtr file, uint access, ref OA attributes, out IO io, uint share, uint options);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetKernelObjectSecurity(IntPtr h,uint info,byte[] data,uint size,out uint needed);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetKernelObjectSecurity(IntPtr h,uint info,byte[] data);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
  static byte[] Read(IntPtr h) {
    uint n; GetKernelObjectSecurity(h,7,null,0,out n);
    if(n==0 || n>1048576) throw new InvalidOperationException("Invalid NUL descriptor size");
    byte[] b=new byte[n]; if(!GetKernelObjectSecurity(h,7,b,n,out n)) throw new System.ComponentModel.Win32Exception(); return b;
  }
  static int FileMask(int value) {
    uint m=unchecked((uint)value);
    if((m&0x80000000u)!=0)m=(m&~0x80000000u)|0x00120089u;
    if((m&0x40000000u)!=0)m=(m&~0x40000000u)|0x00120116u;
    if((m&0x20000000u)!=0)m=(m&~0x20000000u)|0x001200a0u;
    if((m&0x10000000u)!=0)m=(m&~0x10000000u)|0x001f01ffu;
    return unchecked((int)m);
  }
  static string Difference(RawAcl expected,RawAcl actual) {
    string detail="counts="+expected.Count+"/"+actual.Count+", revisions="+expected.Revision+"/"+actual.Revision;
    for(int i=0;i<Math.Min(expected.Count,actual.Count);i++) {
      byte[] a=new byte[expected[i].BinaryLength],b=new byte[actual[i].BinaryLength];expected[i].GetBinaryForm(a,0);actual[i].GetBinaryForm(b,0);
      if(Convert.ToBase64String(a)!=Convert.ToBase64String(b)) {
        var x=expected[i] as CommonAce;var y=actual[i] as CommonAce;
        return detail+", ace="+i+", types="+expected[i].AceType+"/"+actual[i].AceType+", flags="+expected[i].AceFlags+"/"+actual[i].AceFlags+(x!=null&&y!=null?", masks="+unchecked((uint)x.AccessMask).ToString("x8")+"/"+unchecked((uint)y.AccessMask).ToString("x8")+", sidEqual="+x.SecurityIdentifier.Equals(y.SecurityIdentifier):"");
      }
    }
    return detail;
  }
  public static bool Run(bool apply) {
    // The only opened object is the fixed native null device. No pathname input.
    IntPtr text=Marshal.StringToHGlobalUni("\\Device\\Null"), name=IntPtr.Zero, h=IntPtr.Zero;
    try {
      US u=new US {Length=24,MaximumLength=24,Buffer=text};
      name=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(US))); Marshal.StructureToPtr(u,name,false);
      OA a=new OA {Length=Marshal.SizeOf(typeof(OA)),ObjectName=name,Attributes=64}; IO io;
      int status=NtOpenFile(out h,0x20000u|(apply?0x40000u:0),ref a,out io,7,0x40);
      if(status<0) throw new InvalidOperationException("NUL open failed: "+unchecked((uint)status).ToString("x8"));
      var before=new RawSecurityDescriptor(Read(h),0); var sid=new SecurityIdentifier("S-1-15-2-1");
      // File objects map GR|GW to FILE_GENERIC_READ|FILE_GENERIC_WRITE.
      // Install concrete rights so exact binary readback does not depend on
      // the kernel's generic-mask normalization (0xc0000000 -> 0x0012019f).
      const int mask=0x0012019f; int granted=0;
      if(before.DiscretionaryAcl==null) throw new InvalidOperationException("A null NUL DACL is not accepted");
      foreach(GenericAce ace in before.DiscretionaryAcl) { var q=ace as CommonAce; if(q!=null && q.AceQualifier==AceQualifier.AccessAllowed && q.SecurityIdentifier.Equals(sid) && q.AceFlags==AceFlags.None) granted|=FileMask(q.AccessMask); }
      if((granted&mask)==mask) return true;
      if(!apply) return false;
      // Add only missing GR/GW; preserve every existing ACE, owner, group and label.
      int index=before.DiscretionaryAcl.Count;
      for(int i=0;i<before.DiscretionaryAcl.Count;i++) if((before.DiscretionaryAcl[i].AceFlags&AceFlags.Inherited)!=0) {index=i;break;}
      before.DiscretionaryAcl.InsertAce(index,new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,mask&~granted,sid,false,null));
      byte[] updated=new byte[before.BinaryLength];before.GetBinaryForm(updated,0);
      if(!SetKernelObjectSecurity(h,4,updated)) throw new System.ComponentModel.Win32Exception();
      var after=new RawSecurityDescriptor(Read(h),0);
      byte[] actual=new byte[after.DiscretionaryAcl.BinaryLength],expected=new byte[before.DiscretionaryAcl.BinaryLength];
      after.DiscretionaryAcl.GetBinaryForm(actual,0);before.DiscretionaryAcl.GetBinaryForm(expected,0);
      if(!after.Owner.Equals(before.Owner) || !after.Group.Equals(before.Group) || !Convert.ToBase64String(actual).Equals(Convert.ToBase64String(expected))) throw new InvalidOperationException("NUL DACL readback mismatch: ownerEqual="+after.Owner.Equals(before.Owner)+", groupEqual="+after.Group.Equals(before.Group)+", "+Difference(before.DiscretionaryAcl,after.DiscretionaryAcl));
      return true;
    } finally {
      if(h!=IntPtr.Zero && h!=new IntPtr(-1) && !CloseHandle(h)) throw new System.ComponentModel.Win32Exception();
      if(name!=IntPtr.Zero) Marshal.FreeHGlobal(name); Marshal.FreeHGlobal(text);
    }
  }
}
'@
$ready = [CrotNullPreparation]::Run([bool]$Apply)
if (-not $ready) { throw 'NUL policy is missing. Explicitly run scripts/l1-install-win.ps1 -Apply as administrator.' }
Write-Output '{"nulPolicyReady":true,"scope":"null-device-only"}'
