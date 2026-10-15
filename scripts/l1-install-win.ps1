# AD-29. Explicit administrator host preparation. Never called by CrotService.
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference = 'Stop'
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
if ($Apply -and -not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Для -Apply требуется явно запущенный администратором PowerShell.'
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
    if(n==0 || n>1048576) throw new InvalidOperationException("Размер дескриптора NUL");
    byte[] b=new byte[n]; if(!GetKernelObjectSecurity(h,7,b,n,out n)) throw new System.ComponentModel.Win32Exception(); return b;
  }
  public static bool Run(bool apply) {
    // The only opened object is the fixed native null device. No pathname input.
    IntPtr text=Marshal.StringToHGlobalUni("\\Device\\Null"), name=IntPtr.Zero, h=IntPtr.Zero;
    try {
      US u=new US {Length=24,MaximumLength=24,Buffer=text};
      name=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(US))); Marshal.StructureToPtr(u,name,false);
      OA a=new OA {Length=Marshal.SizeOf(typeof(OA)),ObjectName=name,Attributes=64}; IO io;
      int status=NtOpenFile(out h,0x20000u|(apply?0x40000u:0),ref a,out io,7,0x40);
      if(status<0) throw new InvalidOperationException("Открытие NUL: "+unchecked((uint)status).ToString("x8"));
      var before=new RawSecurityDescriptor(Read(h),0); var sid=new SecurityIdentifier("S-1-15-2-1");
      const int mask=unchecked((int)0xc0000000); int granted=0;
      if(before.DiscretionaryAcl==null) throw new InvalidOperationException("Пустая DACL NUL не принимается");
      foreach(GenericAce ace in before.DiscretionaryAcl) { var q=ace as CommonAce; if(q!=null && q.AceQualifier==AceQualifier.AccessAllowed && q.SecurityIdentifier.Equals(sid) && q.AceFlags==AceFlags.None) granted|=q.AccessMask; }
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
      if(!after.Owner.Equals(before.Owner) || !after.Group.Equals(before.Group) || !Convert.ToBase64String(actual).Equals(Convert.ToBase64String(expected))) throw new InvalidOperationException("Проверка DACL NUL");
      return true;
    } finally {
      if(h!=IntPtr.Zero && h!=new IntPtr(-1) && !CloseHandle(h)) throw new System.ComponentModel.Win32Exception();
      if(name!=IntPtr.Zero) Marshal.FreeHGlobal(name); Marshal.FreeHGlobal(text);
    }
  }
}
'@
$ready = [CrotNullPreparation]::Run([bool]$Apply)
if (-not $ready) { throw 'Подготовка NUL отсутствует. Явно выполните scripts/l1-install-win.ps1 -Apply от администратора.' }
Write-Output '{"nulPolicyReady":true,"scope":"null-device-only"}'
